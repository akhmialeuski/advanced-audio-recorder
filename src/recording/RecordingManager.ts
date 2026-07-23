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
import type {
	AudioRecorderSettings,
	OutputMode,
} from '../settings/settingsSchema';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
	validateSelectedDevices,
} from './AudioStreamHandler';
import type { TrackAudioSource } from './AudioStreamHandler';
import {
	PLUGIN_LOG_PREFIX,
	RECORDER_STOP_TIMEOUT_MS,
	PCM_FLUSH_THRESHOLD_BYTES,
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	DEFAULT_BITRATE,
	FORMAT_WEBM,
	FORMAT_WAV,
} from '../constants';
import {
	getChunkFlushThresholdBytes,
	isAutoSplitSupported,
	isPcmWavCaptureSupported,
	isRecoveryJournalSupported,
} from '../platform/capabilities';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	resolveEffectiveOutputFormat,
} from '../audio/AudioCapabilityDetector';
import {
	CHANNEL_MODE_SOURCE,
	isMonoChannelMode,
	normalizeChannelMode,
	type ChannelMode,
} from '../audio/downmix';
import { MonoCaptureBridge } from './MonoCaptureBridge';
import type { PcmStreamRecorder } from './PcmStreamRecorder';
import {
	createAndStartMediaRecorders,
	createPcmRecorders,
	detachRecorderHandlers,
} from './RecorderFactory';
import { describeRecordingError } from './recordingErrors';
import { InputLevelMonitor } from './InputLevelMonitor';
import { resolveRecorderFormat } from '../audio/AudioFormatConverter';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { TrackWriteQueue } from './TrackWriteQueue';
import { RecordingFinalizer } from './RecordingFinalizer';
import { PartRotationController } from './PartRotationController';
import { SessionJournal } from './SessionJournal';
import {
	clampSplitMinutes,
	computePcmPartLimitBytes,
	sanitizePartSuffix,
} from './AudioSplitter';
import { captureInsertionContext } from './NoteInserter';
import { sessionTimestamp } from '../utils/ids';

/**
 * Manages the audio recording lifecycle.
 */
export class RecordingManager {
	private recorders: MediaRecorder[] = [];
	private pcmRecorders: PcmStreamRecorder[] = [];
	private chunkTargets: RecordingTarget[] = [];
	private streams: MediaStream[] = [];
	/** Mono bridges wrapping the raw streams (MediaRecorder path only). */
	private monoBridges: MonoCaptureBridge[] = [];
	/** Streams the MediaRecorders record from (bridged or raw). */
	private captureStreams: MediaStream[] = [];
	/**
	 * Channel mode per stream for the current session (snapshot,
	 * aligned with the streams array). Multi-track sessions read each
	 * track's own mode; single-track sessions read the global setting.
	 */
	private sessionChannelModes: ChannelMode[] = [];
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
	private isWavPcmRecording: boolean = false;
	private activeRecorderFormat: string = FORMAT_WEBM;
	private insertionContext: InsertionContext | null = null;
	/** Whether auto-split is active for the current session (snapshot). */
	private sessionSplitEnabled: boolean = false;
	/** Part duration in minutes for the current session (snapshot). */
	private sessionPartMinutes: number = DEFAULT_SPLIT_CHUNK_MINUTES;
	/** Part name suffix for the current session (snapshot). */
	private sessionPartSuffix: string = DEFAULT_SPLIT_PART_SUFFIX;
	/** Output format for the current session (snapshot). */
	private sessionOutputFormat: string = FORMAT_WEBM;
	/** Output mode for the current session (snapshot). */
	private sessionOutputMode: OutputMode = 'multiple';
	/** Encoder bitrate for the current session (snapshot). */
	private sessionBitrate: number = DEFAULT_BITRATE;
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
		getWorkerClient: () => EncodingWorkerClient | null = () => null,
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
					const recordersToStop = [...this.recorders];
					await Promise.all(
						recordersToStop.map((recorder) =>
							this.stopMediaRecorder(recorder),
						),
					);
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
	 * Whether a marker can be dropped right now: a session must be active
	 * (recording or paused) and the player markers feature must be enabled,
	 * since markers are only ever surfaced by the enhanced player.
	 */
	canDropMarker(): boolean {
		return (
			(this.status === RecordingStatus.Recording ||
				this.status === RecordingStatus.Paused) &&
			this.settings.playerEnableMarkers
		);
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
	 */
	async startRecording(): Promise<void> {
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
			this.isWavPcmRecording =
				outputFormat === FORMAT_WAV && isPcmWavCaptureSupported();

			if (!this.isWavPcmRecording) {
				const { recorderFormat, mimeType } =
					resolveRecorderFormat(outputFormat);
				this.activeRecorderFormat = recorderFormat;
				this.debugLogger.logMimeType(mimeType);
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

			this.snapshotSessionSettings(streams.length, outputFormat);
			const sessionConfig = {
				// Platforms without the recovery journal must never leave
				// raw mid-stream segments behind, so their buffer flushes
				// run as full part rotations at this size boundary.
				chunkRotationBytes: isRecoveryJournalSupported()
					? null
					: getChunkFlushThresholdBytes(),
				isWavPcm: this.isWavPcmRecording,
				recorderFormat: this.activeRecorderFormat,
				outputFormat: this.sessionOutputFormat,
				outputMode: this.sessionOutputMode,
				bitrate: this.sessionBitrate,
				splitEnabled: this.sessionSplitEnabled,
				partMinutes: this.sessionPartMinutes,
				partSuffix: this.sessionPartSuffix,
			};
			this.writeQueue.beginSession(sessionConfig);
			this.finalizer.beginSession(sessionConfig);
			this.rotation.beginSession(sessionConfig);

			this.recordingStartTime = Date.now();
			this.recordingTimestamp = sessionTimestamp();
			this.totalChunks = 0;
			this.markers.beginSession();
			this.recordedBytes = 0;
			this.startLevelMonitor();

			if (this.isWavPcmRecording) {
				await this.initPcmRecording();
			} else {
				await this.initMediaRecording();
			}

			if (isRecoveryJournalSupported()) {
				// Where the journal is unavailable (mobile), flushes run as
				// rotations whose segments are converted and removed right
				// away, so there is nothing lasting to journal
				this.journal.startSession({
					sessionId:
						this.recordingTimestamp ??
						String(this.recordingStartTime),
					startedAt: this.recordingStartTime,
					outputFormat: this.sessionOutputFormat,
					recorderFormat: this.activeRecorderFormat,
					bitrate: this.sessionBitrate,
					tracks: this.chunkTargets.map((target) => ({
						fileBaseName: target.fileBaseName,
						isPcm: this.isWavPcmRecording,
						pcmChannels: target.pcmChannels,
						pcmSampleRate: target.pcmSampleRate,
						segmentPaths: [],
						partPaths: [],
					})),
				});
			}

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
		} catch (error) {
			this.releasePartialSession();
			this.handleStartRecordingError(error);
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
		for (const recorder of this.pcmRecorders) {
			recorder.stop().catch((error: unknown) => {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to release PCM recorder after start failure:`,
					error,
				);
			});
		}
		for (const recorder of this.recorders) {
			try {
				if (recorder.state !== 'inactive') {
					recorder.stop();
				}
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to stop recorder after start failure:`,
					error,
				);
			}
		}
		this.releaseMonoBridges();
		stopAllStreams(this.streams);
		this.streams = [];
		detachRecorderHandlers(this.recorders);
		this.recorders = [];
		this.pcmRecorders = [];
		this.chunkTargets = [];
		this.trackOrder = [];
		this.recordingTimestamp = null;
		this.insertionContext = null;
		this.markers.clearBuffer();
	}

	/**
	 * Snapshots the session-scoped settings (output format, output
	 * mode, bitrate, auto-split configuration) used by the per-track
	 * part and finalization paths, which read them repeatedly during
	 * the session: updateSettings swaps the settings reference while
	 * recording, and without the snapshot each rotation could produce
	 * a part in a different format, or an outputMode change could
	 * reroute a split session into the merged finalization and drop
	 * its part files from the inserted links.
	 * Auto-split is skipped for merged multi-track output because the
	 * tracks are mixed only once at stop.
	 * @param streamCount - Number of acquired audio streams
	 * @param outputFormat - Effective output format resolved for this
	 *   session (the stored preference, or the platform fallback)
	 */
	private snapshotSessionSettings(
		streamCount: number,
		outputFormat: string,
	): void {
		this.sessionOutputFormat = outputFormat;
		this.sessionOutputMode = this.settings.outputMode;
		this.sessionBitrate = this.settings.bitrate;
		// Normalized once per session: capture primitives branch on the
		// modes, and a hand-edited data.json must not leave them split
		// between mono and pass-through behavior. Multi-track device ids
		// and channel modes were captured together before getUserMedia,
		// so a settings edit while permission is pending cannot combine
		// one device with another device's mode. The global setting covers
		// the single-track session.
		this.sessionChannelModes =
			this.trackOrder.length > 0
				? this.trackOrder.map((source) =>
						normalizeChannelMode(source.channelMode),
					)
				: Array.from({ length: streamCount }, () =>
						normalizeChannelMode(this.settings.recordingChannels),
					);
		this.sessionPartMinutes = clampSplitMinutes(
			this.settings.splitChunkMinutes,
		);
		this.sessionPartSuffix = sanitizePartSuffix(
			this.settings.splitPartSuffix,
		);
		this.sessionSplitEnabled =
			this.settings.autoSplitEnabled && isAutoSplitSupported();
		if (this.settings.autoSplitEnabled && !isAutoSplitSupported()) {
			new Notice('Auto-split is not available on this device.');
		}

		if (
			this.sessionSplitEnabled &&
			this.sessionOutputMode === 'single' &&
			streamCount > 1
		) {
			this.sessionSplitEnabled = false;
			new Notice(
				'Auto-split is skipped for merged multi-track recordings.',
			);
		}

		if (this.sessionSplitEnabled) {
			this.debugLogger.log('Auto-split enabled for this session', {
				partMinutes: this.sessionPartMinutes,
				partSuffix: this.sessionPartSuffix,
			});
		}
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
		}));
	}

	/**
	 * Initializes PCM recording for WAV output on desktop.
	 * Creates PcmStreamRecorder instances and segment-based targets.
	 */
	private async initPcmRecording(): Promise<void> {
		this.chunkTargets = await this.createChunkTargets(this.streams.length);

		this.pcmRecorders = createPcmRecorders(
			this.streams,
			this.settings.sampleRate,
			(index, data) => {
				void this.handlePcmChunk(index, data);
			},
			this.sessionChannelModes,
		);

		await Promise.all(
			this.pcmRecorders.map(async (recorder, index) => {
				await recorder.start();
				const target = this.chunkTargets[index];
				if (!target) {
					return;
				}
				target.pcmChannels = recorder.channels;
				target.pcmSampleRate = recorder.sampleRate;
			}),
		);
	}

	/**
	 * Initializes MediaRecorder-based recording for non-WAV formats
	 * and mobile WAV. A mono channel mode wraps every raw stream in a
	 * MonoCaptureBridge so the recorders encode mono at capture time,
	 * without a second lossy generation at finalization.
	 */
	private async initMediaRecording(): Promise<void> {
		this.chunkTargets = await this.createChunkTargets(this.streams.length);
		// One bridge per mono-mode stream, aligned by index; tracks in
		// the source mode record their raw stream. Every bridge
		// registers before any starts, so a failed start (e.g. an audio
		// context stuck in the suspended state) still releases all
		// acquired contexts via releasePartialSession.
		const bridgeByStream = this.streams.map((stream, index) => {
			const mode = this.sessionChannelModes[index] ?? CHANNEL_MODE_SOURCE;
			return isMonoChannelMode(mode)
				? new MonoCaptureBridge(stream, mode, this.settings.sampleRate)
				: null;
		});
		this.monoBridges = bridgeByStream.filter(
			(bridge): bridge is MonoCaptureBridge => bridge !== null,
		);
		this.captureStreams = await Promise.all(
			this.streams.map(
				(stream, index) =>
					bridgeByStream[index]?.start() ?? Promise.resolve(stream),
			),
		);
		this.startMediaRecorders();
	}

	/**
	 * Creates and starts MediaRecorders on the current streams via the
	 * recorder factory. Used at recording start and after each auto-split
	 * part rotation.
	 */
	private startMediaRecorders(): void {
		// The recorders being replaced (initial start: none; part rotation:
		// the stopped previous batch) must not fire a late chunk into the
		// new part's accounting.
		detachRecorderHandlers(this.recorders);
		this.recorders = createAndStartMediaRecorders(
			this.captureStreams,
			{
				mimeType: buildMimeType(this.activeRecorderFormat),
				bitrate: this.sessionBitrate,
			},
			{
				onChunk: (index, data) => {
					void this.handleChunk(index, data);
					this.debugLogger.logChunkSize(index, data.size);
				},
				onError: (_index, event) => {
					console.error(
						`${PLUGIN_LOG_PREFIX} Recorder error:`,
						event,
					);
					new Notice(
						'Recording error occurred. Check console for details.',
					);
				},
			},
		);
	}

	/**
	 * Handles errors during recording start with user-friendly messages.
	 */
	private handleStartRecordingError(error: unknown): void {
		new Notice(describeRecordingError(error));
		console.error(`${PLUGIN_LOG_PREFIX} Error in startRecording:`, error);
	}

	/**
	 * Stops the current recording and saves the files.
	 */
	async stopRecording(): Promise<void> {
		// Block new part rotations from starting while stopping; a
		// false return means another stop is already in flight
		if (!this.rotation.requestStop()) {
			return;
		}
		// Snapshot active audio time before recorder shutdown and saving add
		// wall-clock latency. The post-save detector uses this to reject long
		// sessions before reading or decoding their files.
		const activeDurationSeconds =
			this.rotation.getSessionActiveMs(this.status) / 1000;

		try {
			// Let an in-flight part rotation finish before tearing down:
			// it replaces this.recorders, and its part files must be
			// written before the residual is saved
			await this.rotation.waitForPendingRotation();

			if (this.isWavPcmRecording) {
				await Promise.all(
					this.pcmRecorders.map((recorder) => recorder.stop()),
				);
			} else {
				await Promise.all(
					this.recorders.map((recorder) =>
						this.stopMediaRecorder(recorder),
					),
				);
			}

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
			new Notice(`Error stopping recording: ${message}`);
			console.error(
				`${PLUGIN_LOG_PREFIX} Error in stopRecording:`,
				error,
			);
		} finally {
			this.stopLevelMonitor();
			this.releaseMonoBridges();
			stopAllStreams(this.streams);
			this.streams = [];
			detachRecorderHandlers(this.recorders);
			this.recorders = [];
			this.pcmRecorders = [];
			this.chunkTargets = [];
			this.trackOrder = [];
			this.recordingTimestamp = null;
			this.totalChunks = 0;
			this.recordedBytes = 0;
			this.isWavPcmRecording = false;
			this.insertionContext = null;
			this.sessionSplitEnabled = false;
			this.markers.clearBuffer();
			this.setStatus(RecordingStatus.Idle);
		}
	}

	/**
	 * Stops a MediaRecorder and resolves once its stop event has fired,
	 * which guarantees the final dataavailable chunk was delivered.
	 * Resolves immediately for recorders that are already inactive
	 * (e.g. stopped by an in-flight part rotation), because calling
	 * stop() on an inactive recorder throws. A watchdog timeout keeps
	 * the stop sequence from hanging forever when the audio subsystem
	 * died and the stop event never arrives; the chunks delivered so
	 * far are still saved.
	 * @param recorder - Recorder to stop
	 */
	private stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
		return new Promise<void>((resolve) => {
			if (recorder.state === 'inactive') {
				resolve();
				return;
			}
			const watchdog = window.setTimeout(() => {
				console.error(
					`${PLUGIN_LOG_PREFIX} MediaRecorder stop event did not arrive within ${String(
						RECORDER_STOP_TIMEOUT_MS,
					)} ms; continuing with the data received so far`,
				);
				resolve();
			}, RECORDER_STOP_TIMEOUT_MS);
			recorder.addEventListener(
				'stop',
				() => {
					window.clearTimeout(watchdog);
					resolve();
				},
				{ once: true },
			);
			try {
				recorder.stop();
			} catch (error) {
				// The recorder went inactive between the state check and
				// stop(): its data is already delivered, nothing to wait for
				window.clearTimeout(watchdog);
				console.error(
					`${PLUGIN_LOG_PREFIX} MediaRecorder stop() failed:`,
					error,
				);
				resolve();
			}
		});
	}

	/**
	 * Toggles pause/resume state.
	 */
	togglePauseResume(): void {
		if (this.status === RecordingStatus.Recording) {
			if (this.isWavPcmRecording) {
				this.pcmRecorders.forEach((recorder) => recorder.pause());
			} else {
				// During a part rotation the recorders are momentarily
				// inactive and pausing them would throw; the rotation
				// re-applies the paused status when it restarts capture
				this.recorders.forEach((recorder) => {
					if (recorder.state !== 'inactive') {
						recorder.pause();
					}
				});
			}
			// Freeze active-time accounting used by auto-split rotation
			this.rotation.markPaused();
			this.setStatus(RecordingStatus.Paused);
			new Notice('Recording paused');
		} else if (this.status === RecordingStatus.Paused) {
			if (this.isWavPcmRecording) {
				this.pcmRecorders.forEach((recorder) => recorder.resume());
			} else {
				// Skip recorders stopped by an in-flight part rotation;
				// they are recreated in the resumed state
				this.recorders.forEach((recorder) => {
					if (recorder.state !== 'inactive') {
						recorder.resume();
					}
				});
			}
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
		this.sessionSplitEnabled = false;
		this.stopLevelMonitor();
		for (const recorder of this.pcmRecorders) {
			recorder.stop().catch((error: unknown) => {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to release PCM recorder on unload:`,
					error,
				);
			});
		}
		for (const recorder of this.recorders) {
			try {
				if (recorder.state !== 'inactive') {
					recorder.stop();
				}
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to stop recorder on unload:`,
					error,
				);
			}
		}
		for (const target of this.chunkTargets) {
			void this.writeQueue.enqueue(target, async () => {
				await this.writeQueue.flushChunkBuffer(target);
				await this.writeQueue.flushPcmBuffer(target);
			});
		}
		this.releaseMonoBridges();
		stopAllStreams(this.streams);
		detachRecorderHandlers(this.recorders);
		this.recorders = [];
		this.pcmRecorders = [];
		this.chunkTargets = [];
		this.streams = [];
		this.recordingTimestamp = null;
		this.totalChunks = 0;
		this.isWavPcmRecording = false;
		this.insertionContext = null;
	}

	/**
	 * Releases the mono capture bridges and clears the capture-stream
	 * list. Runs on every teardown path (stop, unload, failed start);
	 * bridge release never throws, so teardown always completes.
	 */
	private releaseMonoBridges(): void {
		for (const bridge of this.monoBridges) {
			bridge.release();
		}
		this.monoBridges = [];
		this.captureStreams = [];
	}

	private setStatus(
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	): void {
		this.status = status;
		this.onStatusChange(status, saveProgress);
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
			if (this.sessionSplitEnabled) {
				target.partPcmBytes += data.byteLength;
				const partLimitBytes = computePcmPartLimitBytes(
					this.sessionPartMinutes,
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
	 * Recreates and starts the MediaRecorders after a part rotation,
	 * re-applying the paused state. A restart failure (e.g. the input
	 * device disappeared mid-session) would otherwise leave the session
	 * silently dead - status Recording with no recorder running - so
	 * the session is stopped to salvage the parts already written.
	 */
	private restartMediaRecorders(): void {
		try {
			this.startMediaRecorders();
			if (this.status === RecordingStatus.Paused) {
				this.recorders.forEach((recorder) => recorder.pause());
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
