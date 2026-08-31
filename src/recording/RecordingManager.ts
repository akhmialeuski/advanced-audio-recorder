/**
 * Recording manager for handling audio recording lifecycle.
 * @module recording/RecordingManager
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type {
	InsertionContext,
	RecordingSaveResult,
	RecordingTarget,
	SaveProgress,
} from '../types';
import { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { MarkerKind } from '../markers/markerModel';
import type { RecordingMarkerHandle } from './recordingMarkers';
import { RecordingMarkerCoordinator } from './RecordingMarkerCoordinator';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
	validateSelectedDevices,
} from './AudioStreamHandler';
import type { TrackAudioSource } from './AudioStreamHandler';
import {
	PLUGIN_LOG_PREFIX,
	PCM_FLUSH_THRESHOLD_BYTES,
	FORMAT_WEBM,
	FORMAT_WAV,
} from '../constants';
import {
	getChunkFlushThresholdBytes,
	isMidStreamSegmentFlushAllowed,
	isPcmWavCaptureSupported,
} from '../platform/capabilities';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	resolveEffectiveOutputFormat,
} from '../audio/AudioCapabilityDetector';
import { CHANNEL_MODE_SOURCE } from '../audio/downmix';
import { CaptureLossWatcher } from './CaptureLossWatcher';
import { createPcmRecorders } from './RecorderFactory';
import { describeRecordingError } from './recordingErrors';
import { InputLevelMonitor } from './InputLevelMonitor';
import { resolveRecorderFormat } from '../audio/AudioFormatConverter';
import { WAV_PCM_WARNING_BYTES } from '../audio/WavEncoder';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { TrackWriteQueue } from './TrackWriteQueue';
import { RecordingFinalizer } from './RecordingFinalizer';
import { mixLayout } from './StreamingMixer';
import { PartRotationController } from './PartRotationController';
import { SessionJournal } from './SessionJournal';
import { computePcmPartLimitBytes } from './AudioSplitter';
import { captureInsertionContext } from './NoteInserter';
import { sessionTimestamp } from '../utils/ids';
import {
	createCaptureSession,
	IDLE_CAPTURE_SESSION,
	type CaptureSession,
} from './CaptureSession';
import {
	type CaptureTrack,
	MediaRecorderCaptureTrack,
	PcmCaptureTrack,
} from './CaptureTrack';

/**
 * Manages the audio recording lifecycle.
 */
export class RecordingManager {
	/**
	 * How each acquired stream is captured, aligned with
	 * {@link RecordingManager.streams}. Which primitive is behind a track is
	 * decided once, when the tracks are built, so every later step of the
	 * session is the same loop over this one list.
	 */
	private captureTracks: CaptureTrack[] = [];
	private chunkTargets: RecordingTarget[] = [];
	private streams: MediaStream[] = [];
	private trackOrder: TrackAudioSource[] = [];
	private status: RecordingStatus = RecordingStatus.Idle;
	private onStatusChange: (
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	) => void;
	private debugLogger: DebugLogger;
	private recordingStartTime: number = 0;
	private recordingTimestamp: string | null = null;
	private totalChunks: number = 0;
	/** Total bytes of audio data observed this session (live size). */
	private recordedBytes: number = 0;
	/** Live input-level meter for the primary stream, when enabled. */
	private levelMonitor: InputLevelMonitor | null = null;
	/** Watches the session's capture devices for going away mid-session. */
	private readonly captureLoss = new CaptureLossWatcher();
	private insertionContext: InsertionContext | null = null;
	/**
	 * Everything this session was fixed to at its start, frozen. Between
	 * sessions it is the idle session, so no reader has to test for null and
	 * an operation arriving late reads settled, harmless answers.
	 */
	private session: CaptureSession = IDLE_CAPTURE_SESSION;
	/** Serialized per-track write queue (buffering and flushes). */
	private readonly writeQueue: TrackWriteQueue;
	/** Finalization stage producing the final files at session stop. */
	private readonly finalizer: RecordingFinalizer;
	/** Auto-split part rotation (timing, reentry, part finalization). */
	private readonly rotation: PartRotationController;
	/** Marker drafts and their persistence for the current session. */
	private readonly markers: RecordingMarkerCoordinator;

	/**
	 * Creates a new RecordingManager.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings
	 * @param onStatusChange - Callback for status changes
	 * @param markerStore - The plugin's single sidecar store, shared with the
	 *   player and transcription so all writers serialize on one write chain
	 */
	constructor(
		private app: App,
		private settings: AudioRecorderSettings,
		onStatusChange: (
			status: RecordingStatus,
			saveProgress?: SaveProgress,
		) => void,
		markerStore: RecordingSidecarStore,
		private readonly journal: SessionJournal = new SessionJournal(
			null,
			app,
		),
		private readonly onRecordingSaved?: (
			result: RecordingSaveResult,
		) => void,
		// No default of its own: the finalizer, which is the only thing that
		// asks for a worker, already falls back to "no worker" - a second
		// default here would be a second answer to the same question.
		getWorkerClient?: () => EncodingWorkerClient | null,
	) {
		this.onStatusChange = onStatusChange;
		this.debugLogger = new DebugLogger(settings);
		this.markers = new RecordingMarkerCoordinator(markerStore);
		this.writeQueue = new TrackWriteQueue(app, settings, journal);
		this.finalizer = new RecordingFinalizer(
			app,
			settings,
			this.writeQueue,
			this.debugLogger,
			(progress: SaveProgress) => {
				this.setStatus(RecordingStatus.Saving, progress);
			},
			journal,
			getWorkerClient,
		);
		this.rotation = new PartRotationController(
			app,
			settings,
			this.writeQueue,
			this.finalizer,
			this.debugLogger,
			{
				getTargets: () => this.chunkTargets,
				getStatus: () => this.status,
				stopRecorders: async () => {
					const stopping = [...this.captureTracks];
					await Promise.all(stopping.map((track) => track.stop()));
				},
				restartRecorders: () => {
					this.restartMediaRecorders();
				},
			},
			journal,
		);
	}

	/**
	 * Gets the current recording status.
	 */
	getStatus(): RecordingStatus {
		return this.status;
	}

	/**
	 * Whether a session is live: capturing or paused mid-capture. A save in
	 * flight is not, because nothing about the session can be changed once it
	 * is being written.
	 */
	isSessionActive(): boolean {
		return (
			this.status === RecordingStatus.Recording ||
			this.status === RecordingStatus.Paused
		);
	}

	/**
	 * Whether a marker can be dropped right now: a session must be active
	 * (recording or paused) and the player markers feature must be enabled,
	 * since markers are only ever surfaced by the enhanced player.
	 */
	canDropMarker(): boolean {
		return this.isSessionActive() && this.settings.playerEnableMarkers;
	}

	/**
	 * Returns the current input level (0..1) for a VU meter, or 0 when no
	 * monitor is running.
	 */
	getInputLevel(): number {
		return this.levelMonitor?.getLevel() ?? 0;
	}

	/**
	 * Returns the total bytes of audio data observed this session.
	 */
	getRecordedBytes(): number {
		return this.recordedBytes;
	}

	/**
	 * Returns the elapsed active recording time in milliseconds, excluding
	 * paused intervals. Zero when idle. Delegates to the rotation
	 * controller, which already owns the pause-aware active-time clock.
	 */
	getElapsedMs(): number {
		if (
			this.status !== RecordingStatus.Recording &&
			this.status !== RecordingStatus.Paused
		) {
			return 0;
		}
		return this.rotation.getSessionActiveMs(this.status);
	}

	/**
	 * Captures a marker at the current position and adds it to the session
	 * buffer immediately, so it survives even if the recording stops while
	 * the naming modal is still open. Returns an editing handle for the
	 * modal, or null when a marker cannot be dropped now.
	 * @param preselectKind - Marker kind fixed by the invoking command;
	 *   defaults to the kind last chosen in the modal
	 */
	captureMarkerDraft(
		preselectKind?: MarkerKind,
	): RecordingMarkerHandle | null {
		if (!this.canDropMarker()) {
			return null;
		}
		const position = this.rotation.getCurrentPartPosition(this.status);
		return this.markers.captureDraft(position, preselectKind);
	}

	/**
	 * Starts the input-level monitor on the primary stream when the meter
	 * is enabled. A failure to start is non-fatal (the meter just stays
	 * at zero).
	 */
	private startLevelMonitor(): void {
		this.stopLevelMonitor();
		if (!this.settings.showInputLevelMeter || this.streams.length === 0) {
			return;
		}
		const primaryStream = this.streams[0];
		if (!primaryStream) {
			return;
		}
		this.levelMonitor = new InputLevelMonitor();
		this.levelMonitor.start(primaryStream);
	}

	/**
	 * Stops and releases the input-level monitor.
	 */
	private stopLevelMonitor(): void {
		this.levelMonitor?.stop();
		this.levelMonitor = null;
	}

	/**
	 * Updates settings reference.
	 * @param settings - New settings
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.settings = settings;
		this.debugLogger.updateSettings(settings);
		this.writeQueue.updateSettings(settings);
		this.finalizer.updateSettings(settings);
		this.rotation.updateSettings(settings);
	}

	/**
	 * Toggles recording on/off.
	 */
	async toggleRecording(): Promise<void> {
		if (this.status === RecordingStatus.Idle) {
			await this.startRecording();
		} else {
			await this.stopRecording();
		}
	}

	/**
	 * Starts a new recording session.
	 *
	 * A failure is reported to the user as a Notice and answered here as the
	 * same sentence, so a caller with nobody in front of it - the command line
	 * - can say why nothing started instead of reading a status that has not
	 * moved.
	 * @returns The reason it did not start, or null once it is recording
	 */
	async startRecording(): Promise<string | null> {
		try {
			// Resolve the format this session actually records in: the
			// stored preference when this device can record it, otherwise
			// the platform's best recordable format. Probes real encoder
			// support, so a format that would only fail at save time is
			// never silently accepted.
			const effectiveFormat = await resolveEffectiveOutputFormat(
				this.settings.recordingFormat,
			);
			if (effectiveFormat.fellBack) {
				new Notice(
					`The format "${this.settings.recordingFormat.toUpperCase()}" cannot be recorded on this device. Recording in ${effectiveFormat.format.toUpperCase()} instead.`,
				);
				this.debugLogger.log('Recording format fallback', {
					requested: this.settings.recordingFormat,
					effective: effectiveFormat.format,
					reason: effectiveFormat.reason,
				});
			}
			const outputFormat = effectiveFormat.format;
			const isWavPcm =
				outputFormat === FORMAT_WAV && isPcmWavCaptureSupported();

			let recorderFormat = FORMAT_WEBM;
			if (!isWavPcm) {
				const resolved = resolveRecorderFormat(outputFormat);
				recorderFormat = resolved.recorderFormat;
				this.debugLogger.logMimeType(resolved.mimeType);
				this.debugLogger.log('Recording format configuration', {
					outputFormat,
					recorderFormat,
					bitrate: this.settings.bitrate,
				});
			} else {
				this.debugLogger.log('WAV recording with direct PCM capture', {
					sampleRate: this.settings.sampleRate,
				});
			}

			await validateSelectedDevices(this.settings);
			const { streams, trackOrder } = await getAudioStreams(
				this.settings,
			);
			this.streams = streams;
			this.trackOrder = trackOrder;

			const plan = createCaptureSession({
				settings: this.settings,
				streamCount: streams.length,
				trackOrder,
				outputFormat,
				recorderFormat,
				isWavPcm,
			});
			this.session = plan.session;
			if (plan.autoSplitSkipped) {
				new Notice(
					'Auto-split is skipped for merged multi-track recordings.',
				);
			}
			if (this.session.splitEnabled) {
				this.debugLogger.log('Auto-split enabled for this session', {
					partMinutes: this.session.partMinutes,
					partSuffix: this.session.partSuffix,
				});
			}
			// One object, handed on rather than rebuilt, so the queue, the
			// finalizer and the rotation controller cannot disagree with the
			// manager about what this session is.
			this.writeQueue.beginSession(this.session);
			this.finalizer.beginSession(this.session);
			this.rotation.beginSession(this.session);

			this.recordingStartTime = Date.now();
			this.recordingTimestamp = sessionTimestamp();
			this.totalChunks = 0;
			this.markers.beginSession();
			this.recordedBytes = 0;
			this.startLevelMonitor();

			await this.buildCaptureTracks();

			// Every session is journaled. What differs per platform is what
			// the journal points at: raw mid-stream segments to concatenate
			// on the desktop, and self-contained rotation parts where a
			// flush must produce a complete file. recordedMs is left unset
			// until the first part lands, so a session that never reached a
			// rotation reports no duration rather than a false zero.
			this.journal.startSession({
				sessionId:
					this.recordingTimestamp ?? String(this.recordingStartTime),
				startedAt: this.recordingStartTime,
				captureMode: isMidStreamSegmentFlushAllowed()
					? 'stream'
					: 'rotation',
				outputFormat: this.session.outputFormat,
				recorderFormat: this.session.recorderFormat,
				bitrate: this.session.bitrate,
				tracks: this.chunkTargets.map((target, index) => ({
					fileBaseName: target.fileBaseName,
					isPcm: this.session.isWavPcm,
					pcmChannels: target.pcmChannels,
					pcmSampleRate: target.pcmSampleRate,
					segmentPaths: [],
					partPaths: [],
					...(this.session.trackMix[index] ?? {}),
				})),
			});

			this.insertionContext = captureInsertionContext(
				this.app,
				this.settings.insertAtOriginalPosition,
				this.debugLogger,
			);
			// Re-anchor part timing now that capture actually runs:
			// recorder and worklet initialization above takes real time
			this.rotation.markResumed();
			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording started');
			// Watched from here rather than from the moment the streams
			// opened. A loss is answered by finalizing the session, so one
			// reported before the session is recording has nothing to act on
			// and used to be dropped for good - the very session that carries
			// on with a dead input. Nothing that happened while the recorders
			// were being built is missed: the watcher reads the state of the
			// tracks as well as subscribing to their events.
			this.captureLoss.start(this.streams, (index, remaining) => {
				this.handleStreamEnded(index, remaining);
			});
			return null;
		} catch (error) {
			this.releasePartialSession();
			return this.handleStartRecordingError(error);
		}
	}

	/**
	 * Releases everything a failed startRecording may have acquired.
	 * Errors after getAudioStreams (an unsupported MediaRecorder
	 * mimeType, a failed worklet load, a failed insertion-context
	 * capture) otherwise leave the microphone captured - device locked
	 * and indicator on - until Obsidian restarts. The journal session
	 * is ended too: nothing was flushed yet, and an orphaned entry
	 * would keep an empty journal file on disk until the next launch
	 * prunes it. Safe in every ordering - the active session id is
	 * either null (failure before the journal start) or the id of the
	 * failed session itself.
	 */
	private releasePartialSession(): void {
		this.journal.endSession();
		this.stopRecordersNow('after start failure');
		this.releaseSessionResources();
	}

	/**
	 * Stops whatever recorders the session built without waiting for their
	 * stop events.
	 *
	 * The two paths that abandon a session rather than finalize it - a failed
	 * start and plugin unload - have nothing left to receive a final chunk, so
	 * they stop the hardware and move on. Every failure is logged and
	 * swallowed: one recorder that refuses to stop must not keep the rest of
	 * the teardown from running.
	 * @param when - Names the path in the log line
	 */
	private stopRecordersNow(when: string): void {
		for (const track of this.captureTracks) {
			track.release(when);
		}
	}

	/**
	 * Releases everything one session acquired, as a single list.
	 *
	 * That list used to be written three times over - the rollback of a failed
	 * start, the `finally` of a normal stop, and unload - and kept in step by
	 * hand. It was not in step: the input-level meter reached two of the three,
	 * so a failed start left the meter's AudioContext open, and Chromium caps
	 * how many of those one document may hold. Reading the list from one place
	 * is what makes a resource added to a session reach every path that ends
	 * one, instead of whichever path its author happened to edit.
	 */
	private releaseSessionResources(): void {
		this.stopLevelMonitor();
		this.captureLoss.release();
		for (const track of this.captureTracks) {
			track.release('while releasing the session');
		}
		this.captureTracks = [];
		stopAllStreams(this.streams);
		this.streams = [];
		this.chunkTargets = [];
		this.trackOrder = [];
		this.recordingTimestamp = null;
		this.totalChunks = 0;
		this.recordedBytes = 0;
		this.insertionContext = null;
		this.session = IDLE_CAPTURE_SESSION;
		this.markers.clearBuffer();
	}

	/**
	 * Creates recording targets for each stream, resolving track
	 * names from device IDs or sequential numbering. Tracks that share
	 * a device produce identical source names; those get the track
	 * number appended, because targets with the same file base name
	 * resolve identical segment paths from concurrent flushes and
	 * overwrite each other's audio. The suffix cannot collide with a
	 * genuine device name: getAudioSourceName strips all
	 * non-alphanumeric characters, so no plain name contains a hyphen.
	 * @param count - Number of targets to create
	 */
	private async createChunkTargets(
		count: number,
	): Promise<RecordingTarget[]> {
		const trackInfos = Array.from({ length: count }, (_, index) => {
			const trackInfo = this.trackOrder[index];
			return {
				trackNumber: trackInfo?.trackNumber ?? index + 1,
				deviceId: trackInfo?.deviceId,
			};
		});
		const sourceNames = await Promise.all(
			trackInfos.map(({ trackNumber, deviceId }) =>
				this.settings.useSourceNamesForTracks && deviceId
					? getAudioSourceName(deviceId)
					: Promise.resolve(`Track${String(trackNumber)}`),
			),
		);
		const nameCounts = new Map<string, number>();
		for (const name of sourceNames) {
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
		const uniqueNames = sourceNames.map((name, index) =>
			(nameCounts.get(name) ?? 0) > 1
				? `${name}-${String(trackInfos[index]?.trackNumber ?? index + 1)}`
				: name,
		);
		return uniqueNames.map((sourceName) => ({
			fileBaseName: `${this.settings.filePrefix}-${sourceName}-${this.recordingTimestamp}`,
			sourceName,
			bufferedChunks: [],
			bufferedBytes: 0,
			segmentIndex: 0,
			segmentPaths: [],
			pendingWrite: Promise.resolve(),
			pcmBuffers: [],
			pcmBufferedBytes: 0,
			pcmChannels: 1,
			pcmSampleRate: this.settings.sampleRate,
			partIndex: 0,
			partPaths: [],
			partPcmBytes: 0,
			filePcmBytes: 0,
			wavCeilingWarned: false,
		}));
	}

	/**
	 * Builds the capture tracks for this session and starts them.
	 *
	 * The choice between the two primitives is made here and nowhere else.
	 * Every track is constructed before any is started, so a start that fails
	 * part way still leaves the rollback a complete list to release - which is
	 * what a mono bridge's audio context depends on, Chromium capping how many
	 * of those one document may hold.
	 *
	 * Starting is two steps for the same reason it is one loop: the tracks of
	 * a session have to begin together, so all of them acquire first and all
	 * of them are armed afterwards.
	 */
	private async buildCaptureTracks(): Promise<void> {
		this.chunkTargets = await this.createChunkTargets(this.streams.length);
		this.captureTracks = this.session.isWavPcm
			? createPcmRecorders(
					this.streams,
					this.settings.sampleRate,
					(index, data) => {
						void this.handlePcmChunk(index, data);
					},
					this.session.channelModes,
				).map((recorder) => new PcmCaptureTrack(recorder))
			: this.streams.map(
					(stream, index) =>
						new MediaRecorderCaptureTrack(
							stream,
							this.session.channelModes[index] ??
								CHANNEL_MODE_SOURCE,
							this.settings.sampleRate,
							{
								mimeType: buildMimeType(
									this.session.recorderFormat,
								),
								bitrate: this.session.bitrate,
							},
							{
								onChunk: (data) => {
									void this.handleChunk(index, data);
									this.debugLogger.logChunkSize(
										index,
										data.size,
									);
								},
								onError: (event) => {
									console.error(
										`${PLUGIN_LOG_PREFIX} Recorder error:`,
										event,
									);
									new Notice(
										'Recording error occurred. Check console for details.',
									);
								},
							},
						),
				);
		await Promise.all(
			this.captureTracks.map(async (track, index) => {
				await track.prepare();
				const target = this.chunkTargets[index];
				if (!target || track.negotiatedChannels === null) {
					return;
				}
				// The PCM worklet answers with what the device gave it, and
				// the WAV header written at the end has to describe that.
				target.pcmChannels = track.negotiatedChannels;
				target.pcmSampleRate =
					track.negotiatedSampleRate ?? target.pcmSampleRate;
			}),
		);
		// Every track is armed only once all of them have acquired what they
		// need. Arming each as its own acquisition returned started the tracks
		// of one session as far apart as their audio contexts took to come up,
		// and a merged file carried that gap as a permanent offset between the
		// microphones.
		for (const track of this.captureTracks) {
			track.begin();
		}
	}

	/**
	 * Answers one capture stream ending.
	 *
	 * A multi-track session keeps whatever is still capturing: pulling one
	 * interface out is a reason to lose that track, not the interview. The
	 * user is told which one went, because "a track stopped" is not something
	 * anybody can act on.
	 *
	 * Losing the last live stream ends the session, keeping everything it
	 * captured: the buffers hold real audio right up to the moment the device
	 * went, so the session is finalized the way a stop does it rather than
	 * discarded. One disconnection can be noticed twice - the track ends and
	 * the device list changes - and this runs once per stream either way,
	 * because {@link CaptureLossWatcher} counts the losses and this reads the
	 * count. Two places deciding that would be two rules for one fact.
	 * @param index - Which of the session's streams ended
	 * @param remaining - How many are still live
	 */
	private handleStreamEnded(index: number, remaining: number): void {
		const name = this.chunkTargets[index]?.sourceName ?? 'the input device';
		if (remaining > 0) {
			// A track recorded straight off its capture stream stops by
			// itself, because a recorder whose stream has gone inactive is
			// ended by the browser. A bridged one does not: what it records
			// is the bridge's own destination track, which stays live and
			// feeds silence for the rest of the session. So one disconnection
			// truncated the file on one capture path and left a full-length
			// silent one on the other, and the sentence below was true of
			// only the first. Releasing this stream's bridge ends its output
			// too, which is the same thing the direct path does.
			this.captureTracks[index]?.detachFromDevice();
			new Notice(
				`Track "${name}" stopped: its input device was disconnected. ` +
					'The other tracks are still recording.',
			);
			return;
		}
		// Capture genuinely ended at this instant, so the active span since
		// the last resume is folded in before the status stops counting it.
		// Without this the saved duration loses everything since that resume.
		if (this.status === RecordingStatus.Recording) {
			this.rotation.markPaused();
		}
		this.setStatus(RecordingStatus.Interrupted);
		new Notice(
			`Recording stopped: the input device "${name}" was disconnected. ` +
				'Saving what was recorded so far.',
		);
		void this.stopRecording();
	}

	/**
	 * Handles errors during recording start with user-friendly messages.
	 * @param error - What the start threw
	 * @returns The sentence the user was shown, for a caller to answer with
	 */
	private handleStartRecordingError(error: unknown): string {
		const message = describeRecordingError(error);
		new Notice(message);
		console.error(`${PLUGIN_LOG_PREFIX} Error in startRecording:`, error);
		return message;
	}

	/**
	 * Stops the current recording and saves the files.
	 *
	 * Answers the way {@link RecordingManager.startRecording} does: a failure
	 * is shown to the user and returned as the same sentence, so a caller with
	 * nobody in front of it can report it.
	 * @returns The reason the stop did not complete, or null once it has
	 */
	async stopRecording(): Promise<string | null> {
		// Block new part rotations from starting while stopping; a
		// false return means another stop is already in flight
		if (!this.rotation.requestStop()) {
			return 'A stop is already in progress.';
		}
		// The watch belongs to the capture, not to the session, and this is
		// where the capture ends. Left running for the save that follows, it
		// still holds live tracks and a devicechange listener, so an input
		// unplugged while a stop the user pressed was writing its file was
		// read as the reason the recording ended: the save relabelled itself
		// "Input lost" and announced a disconnection nobody had suffered.
		this.captureLoss.release();
		// Snapshot active audio time before recorder shutdown and saving add
		// wall-clock latency. The post-save detector uses this to reject long
		// sessions before reading or decoding their files.
		const activeDurationSeconds =
			this.rotation.getSessionActiveMs(this.status) / 1000;
		// Set by both arms below and read after the teardown in `finally`,
		// which runs whichever way the stop went.
		let stopFailure: string | null = null;

		try {
			// Let an in-flight part rotation finish before tearing down:
			// it restarts the tracks, and its part files must be written
			// before the residual is saved
			await this.rotation.waitForPendingRotation();

			await Promise.all(this.captureTracks.map((track) => track.stop()));

			await this.writeQueue.drain(this.chunkTargets);

			this.finalizer.reportProgress(0, 'Saving...');

			const durationMs = Date.now() - this.recordingStartTime;
			this.debugLogger.logRecordingStats(durationMs, this.totalChunks);

			const finalized = await this.finalizer.saveRecording(
				this.chunkTargets,
				this.recordingTimestamp,
				this.insertionContext,
			);
			const saveResult: RecordingSaveResult = {
				...finalized,
				durationSeconds: activeDurationSeconds,
			};
			// Persist live markers before the hook so they are on disk when a
			// post-save action (e.g. opening the player) reads the sidecar
			await this.markers.persistMarkers(saveResult);
			if (saveResult.audioPaths.length > 0) {
				// Fire-and-forget post-save hook (e.g. transcribe-on-save);
				// failures must never break the stop sequence
				try {
					this.onRecordingSaved?.(saveResult);
				} catch (hookError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Post-save hook failed:`,
						hookError,
					);
				}
			}
			// The session finalized cleanly: leftovers already produced
			// their own Notices, and keeping them journaled would raise
			// misleading recovery prompts for audio that is in the final
			// files
			this.journal.endSession();
			await this.journal.flush();
			this.finalizer.reportProgress(100, 'Saved');
			new Notice('Recording stopped');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			stopFailure = `Error stopping recording: ${message}`;
			new Notice(stopFailure);
			console.error(
				`${PLUGIN_LOG_PREFIX} Error in stopRecording:`,
				error,
			);
		} finally {
			this.releaseSessionResources();
			this.setStatus(RecordingStatus.Idle);
		}
		return stopFailure;
	}

	/**
	 * Toggles pause/resume state.
	 */
	togglePauseResume(): void {
		if (this.status === RecordingStatus.Recording) {
			// During a part rotation a browser recorder is momentarily
			// inactive and pausing it would throw; the rotation re-applies
			// the paused status when it restarts capture.
			this.captureTracks.forEach((track) => {
				track.pause();
			});
			// Freeze active-time accounting used by auto-split rotation
			this.rotation.markPaused();
			this.setStatus(RecordingStatus.Paused);
			new Notice('Recording paused');
		} else if (this.status === RecordingStatus.Paused) {
			// A track stopped by an in-flight part rotation is skipped; it
			// is recreated in the resumed state.
			this.captureTracks.forEach((track) => {
				track.resume();
			});
			this.rotation.markResumed();
			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording resumed');
		} else {
			new Notice('No active recording to pause or resume');
		}
	}

	/**
	 * Cleans up resources on unload. onunload is synchronous, so the
	 * async work is fire-and-forget: the AudioContexts and the vault
	 * adapter belong to the app, not the plugin, so the releases and
	 * buffer flushes can still complete after the plugin object is
	 * gone. The crash-recovery journal is deliberately NOT ended - an
	 * unload mid-recording is exactly the case the next launch must
	 * offer to recover. The in-memory tail below the flush threshold
	 * may be lost; everything flushed to disk stays recoverable.
	 */
	cleanup(): void {
		// Prevent an in-flight part rotation from recreating recorders
		// on the released streams after unload
		this.rotation.requestStop();
		// Cleared here rather than with the rest of the session state below,
		// because a PCM chunk arriving during the flushes would otherwise
		// still try to finalize a part on a session that is going away.
		this.session = IDLE_CAPTURE_SESSION;
		this.stopRecordersNow('on unload');
		for (const target of this.chunkTargets) {
			void this.writeQueue.enqueue(target, async () => {
				await this.writeQueue.flushChunkBuffer(target);
				await this.writeQueue.flushPcmBuffer(target);
			});
		}
		this.releaseSessionResources();
	}

	/**
	 * Moves the session to a status and reports it.
	 *
	 * A `Saving` does not displace an `Interrupted`. The session is saving
	 * either way, and what separates the two is why - which holds for as long
	 * as the save does, rather than for the instant it began. Reported as an
	 * ordinary save, which the finalizer's first progress line used to do, the
	 * reason survived only in a Notice the user had already dismissed.
	 * @param status - The status the session is moving to
	 * @param saveProgress - Progress of the save, when one is in flight
	 */
	private setStatus(
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	): void {
		const effective =
			status === RecordingStatus.Saving &&
			this.status === RecordingStatus.Interrupted
				? RecordingStatus.Interrupted
				: status;
		this.status = effective;
		this.onStatusChange(effective, saveProgress);
	}

	private async handleChunk(index: number, data: Blob): Promise<void> {
		const target = this.chunkTargets[index];
		if (!target) {
			return;
		}
		this.totalChunks += 1;
		this.recordedBytes += data.size;
		const flushThreshold = getChunkFlushThresholdBytes();

		await this.writeQueue.enqueue(target, async () => {
			target.bufferedChunks.push(data);
			target.bufferedBytes += data.size;
			// A plain flush writes a raw mid-stream segment, which is only
			// usable where the journaled finalization later concatenates
			// the segments (desktop). Where flushes must produce
			// standalone files instead (mobile), the size boundary is
			// handled by the rotation below, which stops the recorders
			// first so the flushed container is complete.
			if (
				this.rotation.sizeRotationBytes() === null &&
				target.bufferedBytes >= flushThreshold
			) {
				await this.writeQueue.flushChunkBuffer(target);
			}
		});

		// Rotation spans all tracks and restarts the recorders, so it
		// runs outside the per-target pendingWrite chain, guarded
		// against reentry inside the controller. It fires on the
		// auto-split time boundary and on the platform's size boundary.
		this.rotation.maybeRotate();
	}

	private async handlePcmChunk(
		index: number,
		data: ArrayBuffer,
	): Promise<void> {
		const target = this.chunkTargets[index];
		if (!target) {
			return;
		}
		this.totalChunks += 1;
		this.recordedBytes += data.byteLength;

		await this.writeQueue.enqueue(target, async () => {
			target.pcmBuffers.push(data);
			target.pcmBufferedBytes += data.byteLength;
			target.filePcmBytes += data.byteLength;
			this.warnOnApproachingWavCeiling(target);
			if (this.session.splitEnabled) {
				target.partPcmBytes += data.byteLength;
				const partLimitBytes = computePcmPartLimitBytes(
					this.session.partMinutes,
					target.pcmSampleRate,
					target.pcmChannels,
				);
				if (target.partPcmBytes >= partLimitBytes) {
					await this.rotation.finalizePcmPart(target, partLimitBytes);
				}
			}
			if (target.pcmBufferedBytes >= PCM_FLUSH_THRESHOLD_BYTES) {
				await this.writeQueue.flushPcmBuffer(target);
			}
		});
	}

	/**
	 * Tells the user once that the WAV being written is nearing the size a
	 * RIFF container can describe.
	 *
	 * Said while the recording still runs, because the alternative is saying it
	 * at the stop, where the only outcomes left are a refused save or a file
	 * players read as truncated. Auto-split is named because it is the one
	 * setting that takes the ceiling off the session entirely.
	 * @param target - The track whose audio was just written to
	 */
	private warnOnApproachingWavCeiling(target: RecordingTarget): void {
		if (
			target.wavCeilingWarned ||
			this.destinationWavPcmBytes(target) < WAV_PCM_WARNING_BYTES
		) {
			return;
		}
		// Marked on every track feeding the file, not only on the one the
		// crossing was noticed on. The counter this was measured from belongs
		// to the file, so the memory of having spoken about it has to as well:
		// kept per track, a merged session repeated the same warning once for
		// each track as its next chunk arrived.
		for (const feeding of this.targetsSharingDestinationWav(target)) {
			feeding.wavCeilingWarned = true;
		}
		new Notice(
			'This recording is approaching the 4 GB limit of the WAV format. ' +
				'Enable auto-split in the settings, or stop and start a new ' +
				'recording, so the audio can be saved.',
		);
	}

	/**
	 * The tracks whose audio lands in the same WAV as this one's.
	 *
	 * The container ceiling applies to a file, and which tracks make up that
	 * file is one question: a merged session writes one WAV for all of them, a
	 * per-track session writes one for this track alone. Both the size that
	 * faces the ceiling and the memory of having warned about it are properties
	 * of that file, so both ask here instead of each deciding for itself.
	 * @param target - The track whose audio was just written to
	 * @returns The tracks sharing its destination file, itself included
	 */
	private targetsSharingDestinationWav(
		target: RecordingTarget,
	): readonly RecordingTarget[] {
		const merged =
			this.session.isWavPcm &&
			this.session.outputMode === 'single' &&
			this.chunkTargets.length > 1;
		return merged ? this.chunkTargets : [target];
	}

	/**
	 * Size of the WAV this target's audio is actually destined for.
	 *
	 * A session merging its tracks into one file writes no per-track WAV at
	 * all, so the target's own counter names a file that never exists, and the
	 * one that does is larger than any track that feeds it: a mono track
	 * beside a stereo one is mixed up to stereo, which doubles it. Measuring
	 * the track instead of the mix let the merged file pass the ceiling with
	 * no warning at any point.
	 * @param target - The track whose audio was just written to
	 * @returns PCM bytes of the WAV that faces the container ceiling
	 */
	private destinationWavPcmBytes(target: RecordingTarget): number {
		const feeding = this.targetsSharingDestinationWav(target);
		if (feeding.length < 2) {
			return target.filePcmBytes;
		}
		return mixLayout(
			feeding.map((chunkTarget) => ({
				pcmBytes: chunkTarget.filePcmBytes,
				channels: chunkTarget.pcmChannels,
				sampleRate: chunkTarget.pcmSampleRate,
				// A track placed off centre takes the merged file to stereo,
				// which doubles it. The warning has to see the same file the
				// mixer will write, or it lets the ceiling past unannounced.
				pan:
					this.session.trackMix[
						this.chunkTargets.indexOf(chunkTarget)
					]?.pan ?? 0,
			})),
		).pcmByteLength;
	}

	/**
	 * Recreates and starts the MediaRecorders after a part rotation,
	 * re-applying the paused state. A restart failure (e.g. the input
	 * device disappeared mid-session) would otherwise leave the session
	 * silently dead - status Recording with no recorder running - so
	 * the session is stopped to salvage the parts already written.
	 */
	private restartMediaRecorders(): void {
		try {
			const paused = this.status === RecordingStatus.Paused;
			for (const track of this.captureTracks) {
				track.restart(paused);
			}
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to restart recorders after part rotation:`,
				error,
			);
			new Notice(
				'Could not restart recording after saving a part. Stopping and saving the recording.',
			);
			void this.stopRecording();
		}
	}
}
