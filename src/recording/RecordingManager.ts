/**
 * Recording manager for handling audio recording lifecycle.
 * @module recording/RecordingManager
 */

import { Notice, Platform } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type { InsertionContext, RecordingTarget, SaveProgress } from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
	validateSelectedDevices,
} from './AudioStreamHandler';
import { assembleWavFromPcmSegments } from './WavEncoder';
import {
	PLUGIN_LOG_PREFIX,
	CHUNK_TIMESLICE_MS,
	RECORDER_STOP_TIMEOUT_MS,
	MOBILE_BUFFER_LIMIT_BYTES,
	PCM_FLUSH_THRESHOLD_BYTES,
	DESKTOP_FLUSH_THRESHOLD_BYTES,
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	MS_PER_MINUTE,
} from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	validateRecordingCapability,
	DEFAULT_BITRATE,
	FORMAT_WEBM,
	FORMAT_WAV,
} from './AudioCapabilityDetector';
import { isOfflineEncodingSupported } from './AudioEncoder';
import { PcmStreamRecorder } from './PcmStreamRecorder';
import {
	resolveUniquePath,
	saveAudioFile,
	removeTemporaryArtifacts,
	rollbackFinalFile,
	cleanupIntermediateFiles,
} from './RecordingFileManager';
import {
	resolveRecorderFormat,
	isOfflineOnlyFormat,
	getRecorderMediaType,
	convertBlobToWav,
	convertBlobToFormat,
	mergeAudioTracks,
} from './AudioFormatConverter';
import { TrackWriteQueue } from './TrackWriteQueue';
import {
	buildPartFileName,
	clampSplitMinutes,
	computePcmPartLimitBytes,
	detachTrailingBytes,
	sanitizePartSuffix,
	totalByteLength,
} from './AudioSplitter';
import { captureInsertionContext, insertFileLinks } from './NoteInserter';

/**
 * Manages the audio recording lifecycle.
 */
export class RecordingManager {
	private recorders: MediaRecorder[] = [];
	private pcmRecorders: PcmStreamRecorder[] = [];
	private chunkTargets: RecordingTarget[] = [];
	private streams: MediaStream[] = [];
	private trackOrder: { trackNumber: number; deviceId: string }[] = [];
	private status: RecordingStatus = RecordingStatus.Idle;
	private onStatusChange: (
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	) => void;
	private debugLogger: DebugLogger;
	private recordingStartTime: number = 0;
	private recordingTimestamp: string | null = null;
	private totalChunks: number = 0;
	private isMobileRecording: boolean = false;
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
	/** Encoder bitrate for the current session (snapshot). */
	private sessionBitrate: number = DEFAULT_BITRATE;
	/** Active (unpaused) milliseconds accumulated in the current part. */
	private partActiveMs: number = 0;
	/** Timestamp of the last start/resume/rotation for active-time tracking. */
	private activeAnchor: number = 0;
	/** In-flight MediaRecorder part rotation, if any. */
	private rotationPromise: Promise<void> | null = null;
	/** Whether the session is being stopped (blocks new part rotations). */
	private isStopping: boolean = false;
	/** Last save-progress percent reported to the status bar. */
	private lastProgressPercent: number = -1;
	/** Last save-progress description reported to the status bar. */
	private lastProgressDescription: string = '';
	/** Serialized per-track write queue (buffering and flushes). */
	private readonly writeQueue: TrackWriteQueue;

	/**
	 * Creates a new RecordingManager.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings
	 * @param onStatusChange - Callback for status changes
	 */
	constructor(
		private app: App,
		private settings: AudioRecorderSettings,
		onStatusChange: (
			status: RecordingStatus,
			saveProgress?: SaveProgress,
		) => void,
	) {
		this.onStatusChange = onStatusChange;
		this.debugLogger = new DebugLogger(settings);
		this.writeQueue = new TrackWriteQueue(app, settings);
	}

	/**
	 * Gets the current recording status.
	 */
	getStatus(): RecordingStatus {
		return this.status;
	}

	/**
	 * Updates settings reference.
	 * @param settings - New settings
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.settings = settings;
		this.debugLogger.updateSettings(settings);
		this.writeQueue.updateSettings(settings);
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
			this.isStopping = false;
			this.isMobileRecording = Platform.isMobileApp || Platform.isMobile;
			this.isWavPcmRecording =
				this.settings.recordingFormat === FORMAT_WAV &&
				!this.isMobileRecording;

			if (!this.isWavPcmRecording) {
				const { recorderFormat, mimeType } = resolveRecorderFormat(
					this.settings,
				);
				this.activeRecorderFormat = recorderFormat;
				this.debugLogger.logMimeType(mimeType);
				this.debugLogger.log('Recording format configuration', {
					outputFormat: this.settings.recordingFormat,
					recorderFormat,
					bitrate: this.settings.bitrate,
				});
			} else {
				this.debugLogger.log('WAV recording with direct PCM capture', {
					sampleRate: this.settings.sampleRate,
				});
			}

			const validation = validateRecordingCapability(
				this.settings.recordingFormat,
			);
			if (!validation.valid) {
				throw new Error(validation.reason);
			}

			await validateSelectedDevices(this.settings);
			const { streams, trackOrder } = await getAudioStreams(
				this.settings,
			);
			this.streams = streams;
			this.trackOrder = trackOrder;

			this.snapshotSessionSettings(streams.length);
			this.writeQueue.beginSession({
				isMobile: this.isMobileRecording,
				isWavPcm: this.isWavPcmRecording,
				recorderFormat: this.activeRecorderFormat,
				outputFormat: this.sessionOutputFormat,
				bitrate: this.sessionBitrate,
				splitEnabled: this.sessionSplitEnabled,
				partMinutes: this.sessionPartMinutes,
				partSuffix: this.sessionPartSuffix,
			});

			this.recordingStartTime = Date.now();
			this.recordingTimestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, '-');
			this.totalChunks = 0;

			if (this.isWavPcmRecording) {
				await this.initPcmRecording();
			} else {
				await this.initMediaRecording();
			}

			this.insertionContext = captureInsertionContext(
				this.app,
				this.settings.insertAtOriginalPosition,
				this.debugLogger,
			);
			this.partActiveMs = 0;
			this.activeAnchor = Date.now();
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
	 * capture) otherwise leave the microphone captured — device locked
	 * and indicator on — until Obsidian restarts.
	 */
	private releasePartialSession(): void {
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
		stopAllStreams(this.streams);
		this.streams = [];
		this.recorders = [];
		this.pcmRecorders = [];
		this.chunkTargets = [];
		this.trackOrder = [];
		this.recordingTimestamp = null;
		this.insertionContext = null;
	}

	/**
	 * Snapshots the session-scoped settings (output format, bitrate,
	 * auto-split configuration) used by the per-track part and
	 * finalization paths, which read them repeatedly during the
	 * session: updateSettings swaps the settings reference while
	 * recording, and without the snapshot each rotation could produce
	 * a part in a different format. The mobile flush and merged
	 * multi-track stop paths still read live settings, matching their
	 * pre-split behavior. Auto-split is skipped for merged multi-track
	 * output because the tracks are mixed only once at stop.
	 * @param streamCount - Number of acquired audio streams
	 */
	private snapshotSessionSettings(streamCount: number): void {
		this.sessionOutputFormat = this.settings.recordingFormat;
		this.sessionBitrate = this.settings.bitrate;
		this.sessionPartMinutes = clampSplitMinutes(
			this.settings.splitChunkMinutes,
		);
		this.sessionPartSuffix = sanitizePartSuffix(
			this.settings.splitPartSuffix,
		);
		this.sessionSplitEnabled =
			this.settings.autoSplitEnabled && !this.isMobileRecording;
		if (this.settings.autoSplitEnabled && this.isMobileRecording) {
			new Notice('Auto-split is not available in the mobile app.');
		}

		if (
			this.sessionSplitEnabled &&
			this.settings.outputMode === 'single' &&
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
				? `${name}-${String(trackInfos[index].trackNumber)}`
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

		this.pcmRecorders = this.streams.map(
			(stream, index) =>
				new PcmStreamRecorder(
					stream,
					this.settings.sampleRate,
					(data: ArrayBuffer) => {
						void this.handlePcmChunk(index, data);
					},
				),
		);

		await Promise.all(
			this.pcmRecorders.map(async (recorder, index) => {
				await recorder.start();
				const target = this.chunkTargets[index];
				target.pcmChannels = recorder.channels;
				target.pcmSampleRate = recorder.sampleRate;
			}),
		);
	}

	/**
	 * Initializes MediaRecorder-based recording for non-WAV formats
	 * and mobile WAV.
	 */
	private async initMediaRecording(): Promise<void> {
		this.chunkTargets = await this.createChunkTargets(this.streams.length);
		this.createAndStartMediaRecorders();
	}

	/**
	 * Creates MediaRecorder instances on the current streams, attaches
	 * chunk/error handlers, and starts them with the chunk timeslice.
	 * Used at recording start and after each auto-split part rotation.
	 */
	private createAndStartMediaRecorders(): void {
		const mimeType = buildMimeType(this.activeRecorderFormat);
		this.recorders = this.streams.map(
			(stream) =>
				new MediaRecorder(stream, {
					mimeType,
					audioBitsPerSecond: this.sessionBitrate,
				}),
		);

		this.recorders.forEach((recorder, index) => {
			recorder.ondataavailable = (event: BlobEvent): void => {
				if (event.data.size > 0) {
					void this.handleChunk(index, event.data);
					this.debugLogger.logChunkSize(index, event.data.size);
				}
			};
			recorder.onerror = (event: Event): void => {
				console.error(`${PLUGIN_LOG_PREFIX} Recorder error:`, event);
				new Notice(
					'Recording error occurred. Check console for details.',
				);
			};
			recorder.start(CHUNK_TIMESLICE_MS);
		});
	}

	/**
	 * Handles errors during recording start with user-friendly messages.
	 */
	private handleStartRecordingError(error: unknown): void {
		if (error instanceof DOMException) {
			if (error.name === 'NotAllowedError') {
				new Notice(
					'Microphone access denied. Please grant permission in browser settings.',
				);
			} else if (error.name === 'NotFoundError') {
				new Notice(
					'No microphone found. Please connect an audio input device.',
				);
			} else if (error.name === 'NotReadableError') {
				new Notice('Microphone is in use by another application.');
			} else {
				new Notice(`Recording error: ${error.message}`);
			}
		} else {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Error starting recording: ${message}`);
		}
		console.error(`${PLUGIN_LOG_PREFIX} Error in startRecording:`, error);
	}

	/**
	 * Stops the current recording and saves the files.
	 */
	async stopRecording(): Promise<void> {
		if (this.isStopping) {
			return;
		}
		// Block new part rotations from starting while stopping
		// (shouldRotateMediaParts checks this flag)
		this.isStopping = true;

		try {
			// Let an in-flight part rotation finish before tearing down:
			// it replaces this.recorders, and its part files must be
			// written before the residual is saved
			if (this.rotationPromise) {
				await this.rotationPromise;
			}

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

			this.updateSaveProgress(0, 'Saving...');

			const durationMs = Date.now() - this.recordingStartTime;
			this.debugLogger.logRecordingStats(durationMs, this.totalChunks);

			await this.saveRecording();
			this.updateSaveProgress(100, 'Saved');
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
			stopAllStreams(this.streams);
			this.streams = [];
			this.recorders = [];
			this.pcmRecorders = [];
			this.chunkTargets = [];
			this.trackOrder = [];
			this.recordingTimestamp = null;
			this.totalChunks = 0;
			this.isWavPcmRecording = false;
			this.insertionContext = null;
			this.sessionSplitEnabled = false;
			this.partActiveMs = 0;
			this.rotationPromise = null;
			this.isStopping = false;
			this.lastProgressPercent = -1;
			this.lastProgressDescription = '';
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
			this.partActiveMs += Date.now() - this.activeAnchor;
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
			this.activeAnchor = Date.now();
			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording resumed');
		} else {
			new Notice('No active recording to pause or resume');
		}
	}

	/**
	 * Cleans up resources on unload.
	 */
	cleanup(): void {
		// Prevent an in-flight part rotation from recreating recorders
		// on the released streams after unload
		this.isStopping = true;
		this.sessionSplitEnabled = false;
		stopAllStreams(this.streams);
		this.recorders = [];
		this.pcmRecorders = [];
		this.chunkTargets = [];
		this.streams = [];
		this.recordingTimestamp = null;
		this.totalChunks = 0;
		this.isWavPcmRecording = false;
		this.insertionContext = null;
	}

	private setStatus(
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	): void {
		this.status = status;
		this.onStatusChange(status, saveProgress);
	}

	/**
	 * Reports save progress to the status bar, skipping updates whose
	 * whole percent and description did not change. Encoders may emit
	 * progress per audio frame (hundreds of thousands of calls for a
	 * long recording), and every accepted update touches the DOM.
	 * @param percent - Progress percentage (0-100)
	 * @param description - Progress phase description
	 */
	private updateSaveProgress(percent: number, description: string): void {
		const wholePercent = Math.round(percent);
		if (
			wholePercent === this.lastProgressPercent &&
			description === this.lastProgressDescription
		) {
			return;
		}
		this.lastProgressPercent = wholePercent;
		this.lastProgressDescription = description;
		this.setStatus(RecordingStatus.Saving, {
			percent: wholePercent,
			description,
		});
	}

	private async saveRecording(): Promise<void> {
		const timestamp =
			this.recordingTimestamp ??
			new Date().toISOString().replace(/[:.]/g, '-');
		const fileLinks: string[] = [];

		this.updateSaveProgress(20, 'Flushing buffers...');

		if (this.settings.outputMode === 'single') {
			if (this.chunkTargets.length === 1) {
				const target = this.chunkTargets[0];
				const paths = await this.finalizeTrackFiles(target);
				fileLinks.push(...target.partPaths, ...paths);
			} else {
				if (!this.isWavPcmRecording) {
					await Promise.all(
						this.chunkTargets.map((target) =>
							this.writeQueue.flushChunkBuffer(target),
						),
					);
				}
				if (this.isWavPcmRecording) {
					await Promise.all(
						this.chunkTargets.map((target) =>
							this.writeQueue.flushPcmBuffer(target),
						),
					);
				}
				this.updateSaveProgress(40, 'Mixing tracks...');
				const targetFormat = isOfflineEncodingSupported(
					this.settings.recordingFormat,
				)
					? this.settings.recordingFormat
					: FORMAT_WAV;
				if (
					targetFormat === FORMAT_WAV &&
					this.settings.recordingFormat !== FORMAT_WAV
				) {
					this.debugLogger.log(
						'Multi-track single output falls back to WAV (encoding unavailable)',
						{
							requestedFormat: this.settings.recordingFormat,
						},
					);
					new Notice(
						'Merged multi-track output saved as .wav (encoding unavailable for this format).',
					);
				}
				const mergedAudio = await mergeAudioTracks(
					this.chunkTargets,
					this.settings,
					this.isWavPcmRecording,
					(target) => this.buildPcmTrackWavBlob(target),
					(target) => this.buildTrackBlob(target),
					(percent, description) => {
						this.updateSaveProgress(percent, description);
					},
				);
				this.updateSaveProgress(60, 'Writing file...');
				const fileName = `${this.settings.filePrefix}-multitrack-${timestamp}.${targetFormat}`;
				const filePath = await saveAudioFile(
					mergedAudio,
					fileName,
					this.app,
					this.settings,
				);
				if (filePath) {
					this.updateSaveProgress(80, 'Cleaning up...');
					const failedCleanupPaths = await cleanupIntermediateFiles(
						this.chunkTargets,
						this.app,
					);
					if (failedCleanupPaths.length > 0) {
						await rollbackFinalFile(
							filePath,
							'Failed to finalize recording cleanup for merged output',
							this.app,
						);
						throw new Error(
							`Temporary recording artifacts were kept for recovery: ${failedCleanupPaths.join(', ')}`,
						);
					}
					fileLinks.push(filePath);
				} else {
					// An empty merged blob writes no final file; the
					// segment files are the only copy of the captured
					// audio, so they are kept and reported instead of
					// being silently orphaned in the vault
					const keptPaths = this.chunkTargets.flatMap(
						(target) => target.segmentPaths,
					);
					if (keptPaths.length > 0) {
						console.error(
							`${PLUGIN_LOG_PREFIX} Merged output was empty; temporary segment files were kept:`,
							keptPaths,
						);
						new Notice(
							`Merged recording was empty. Temporary track files were kept: ${keptPaths.join(', ')}`,
						);
					}
				}
			}
		} else {
			for (let i = 0; i < this.chunkTargets.length; i++) {
				const target = this.chunkTargets[i];
				const paths = await this.finalizeTrackFiles(target);
				fileLinks.push(...target.partPaths, ...paths);
			}
		}

		if (fileLinks.length > 0) {
			insertFileLinks(fileLinks, this.insertionContext, this.app);
			new Notice(`Saved ${String(fileLinks.length)} audio file(s)`);
		} else {
			new Notice('No audio data recorded');
		}
	}

	private async handleChunk(index: number, data: Blob): Promise<void> {
		const target = this.chunkTargets[index];
		if (!target) {
			return;
		}
		this.totalChunks += 1;
		const flushThreshold = this.isMobileRecording
			? MOBILE_BUFFER_LIMIT_BYTES
			: DESKTOP_FLUSH_THRESHOLD_BYTES;

		await this.writeQueue.enqueue(target, async () => {
			target.bufferedChunks.push(data);
			target.bufferedBytes += data.size;
			if (target.bufferedBytes >= flushThreshold) {
				await this.writeQueue.flushChunkBuffer(target);
			}
		});

		// Rotation spans all tracks and restarts the recorders, so it runs
		// outside the per-target pendingWrite chain, guarded against reentry
		if (this.shouldRotateMediaParts()) {
			this.rotationPromise = this.rotateMediaRecorderParts()
				.catch((error: unknown) => {
					// Backstop: the rotation contains its own error
					// handling, but an unexpected rejection must not
					// become unhandled or poison a concurrent
					// stopRecording awaiting this promise
					console.error(
						`${PLUGIN_LOG_PREFIX} Unexpected error during part rotation:`,
						error,
					);
				})
				.finally(() => {
					this.rotationPromise = null;
				});
		}
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
					await this.finalizePcmPart(target, partLimitBytes);
				}
			}
			if (target.pcmBufferedBytes >= PCM_FLUSH_THRESHOLD_BYTES) {
				await this.writeQueue.flushPcmBuffer(target);
			}
		});
	}

	/**
	 * Checks whether the MediaRecorder-based recording reached the
	 * auto-split part boundary. PCM/WAV recordings split by exact byte
	 * count instead (see handlePcmChunk).
	 */
	private shouldRotateMediaParts(): boolean {
		if (
			!this.sessionSplitEnabled ||
			this.isWavPcmRecording ||
			this.isStopping ||
			this.rotationPromise !== null ||
			this.status !== RecordingStatus.Recording
		) {
			return false;
		}
		const activeMs = this.partActiveMs + (Date.now() - this.activeAnchor);
		return activeMs >= this.sessionPartMinutes * MS_PER_MINUTE;
	}

	/**
	 * Finalizes the current auto-split part of a PCM/WAV recording.
	 * Splits the last buffer at the exact part boundary, assembles the
	 * part WAV file from flushed segments, and carries the overshoot
	 * into the next part, keeping parts sample-exact. Runs inside the
	 * target's pendingWrite chain; errors are contained so they cannot
	 * poison subsequent writes.
	 * @param target - Recording target to finalize
	 * @param partLimitBytes - Exact part size in bytes
	 */
	private async finalizePcmPart(
		target: RecordingTarget,
		partLimitBytes: number,
	): Promise<void> {
		const overshoot = target.partPcmBytes - partLimitBytes;
		const carry =
			overshoot > 0
				? detachTrailingBytes(target.pcmBuffers, overshoot)
				: [];

		target.partIndex += 1;
		try {
			const fileName = buildPartFileName(
				target.fileBaseName,
				this.sessionPartSuffix,
				target.partIndex,
				FORMAT_WAV,
			);
			const filePath = await resolveUniquePath(
				fileName,
				this.app,
				this.settings,
			);
			await this.writeQueue.flushPcmBuffer(target);
			if (target.segmentPaths.length > 0) {
				await this.assembleWavFile(target, filePath);
				target.partPaths.push(filePath);
				this.debugLogger.log('Auto-split part saved', { filePath });
				new Notice(`Recording part ${String(target.partIndex)} saved`);
			}
			target.segmentPaths = [];
			target.segmentIndex = 0;
		} catch (error) {
			// Keep recording without losing audio: whatever was not
			// flushed stays buffered (with the carry re-attached in
			// capture order), flushed segments stay on disk, and all of
			// it lands in the next part. Part accounting restarts from
			// zero so the failed save is retried one part length later,
			// not on every chunk.
			target.partIndex -= 1;
			target.pcmBuffers.push(...carry);
			target.pcmBufferedBytes = totalByteLength(target.pcmBuffers);
			target.partPcmBytes = 0;
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
				error,
			);
			new Notice(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			return;
		}
		target.pcmBuffers = carry;
		target.pcmBufferedBytes = totalByteLength(carry);
		target.partPcmBytes = target.pcmBufferedBytes;
	}

	/**
	 * Rotates MediaRecorder-based recording at an auto-split boundary:
	 * stops the recorders to obtain a complete container, detaches the
	 * buffered data of each track as a snapshot of plain segment files,
	 * restarts the recorders on the same streams, and only then
	 * transcodes the snapshots into part files. Restarting before the
	 * potentially slow transcoding keeps the capture gap limited to
	 * recorder stop plus raw buffer flush time. The recording status
	 * stays Recording the whole time. Errors are contained so the
	 * session keeps recording.
	 */
	private async rotateMediaRecorderParts(): Promise<void> {
		const snapshots: {
			target: RecordingTarget;
			segmentPaths: string[];
		}[] = [];
		try {
			const recordersToStop = [...this.recorders];
			await Promise.all(
				recordersToStop.map((recorder) =>
					this.stopMediaRecorder(recorder),
				),
			);
			await this.writeQueue.drain(this.chunkTargets);

			for (const target of this.chunkTargets) {
				try {
					// Plain file write of already-captured bytes; the
					// expensive transcoding happens after the restart
					await this.writeQueue.flushChunkBuffer(target);
				} catch (error) {
					// Chunks stay buffered in capture order and land in
					// the next part
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to flush buffers at part boundary:`,
						error,
					);
					new Notice(
						'Failed to save recording part. Recording continues; data is kept for the next part.',
					);
					continue;
				}
				if (target.segmentPaths.length > 0) {
					snapshots.push({
						target,
						segmentPaths: target.segmentPaths,
					});
					target.segmentPaths = [];
					target.segmentIndex = 0;
				}
			}
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Error during part rotation:`,
				error,
			);
			new Notice('Failed to rotate recording part. Recording continues.');
		} finally {
			// Restart only while still recording or paused; a concurrent
			// stopRecording awaits this rotation and tears recorders down
			if (
				!this.isStopping &&
				(this.status === RecordingStatus.Recording ||
					this.status === RecordingStatus.Paused)
			) {
				this.restartMediaRecorders();
			}
			this.partActiveMs = 0;
			this.activeAnchor = Date.now();
		}

		// Transcode and write the part files while the next part is
		// already being captured by the restarted recorders
		for (const snapshot of snapshots) {
			await this.finalizeMediaPartSnapshot(
				snapshot.target,
				snapshot.segmentPaths,
			);
		}
	}

	/**
	 * Recreates and starts the MediaRecorders after a part rotation,
	 * re-applying the paused state. A restart failure (e.g. the input
	 * device disappeared mid-session) would otherwise leave the session
	 * silently dead — status Recording with no recorder running — so
	 * the session is stopped to salvage the parts already written.
	 */
	private restartMediaRecorders(): void {
		try {
			this.createAndStartMediaRecorders();
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

	/**
	 * Transcodes one detached rotation snapshot into a part file and
	 * records it on the target. On failure the snapshot segments are
	 * re-attached in front of the data captured since the restart, so
	 * the audio lands in the next part instead of being lost.
	 * @param target - Recording target the snapshot belongs to
	 * @param segmentPaths - Detached segment files in capture order
	 */
	private async finalizeMediaPartSnapshot(
		target: RecordingTarget,
		segmentPaths: string[],
	): Promise<void> {
		target.partIndex += 1;
		try {
			const fileName = buildPartFileName(
				target.fileBaseName,
				this.sessionPartSuffix,
				target.partIndex,
				this.sessionOutputFormat,
			);
			const filePath = await this.finalizeSegmentsToFile(
				segmentPaths,
				fileName,
			);
			if (filePath) {
				target.partPaths.push(filePath);
				this.debugLogger.log('Auto-split part saved', { filePath });
				new Notice(`Recording part ${String(target.partIndex)} saved`);
			} else {
				target.partIndex -= 1;
			}
		} catch (error) {
			target.partIndex -= 1;
			target.segmentPaths = [...segmentPaths, ...target.segmentPaths];
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
				error,
			);
			new Notice(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
		}
	}

	private async assembleWavFile(
		target: RecordingTarget,
		filePath: string,
	): Promise<void> {
		const segments = await Promise.all(
			target.segmentPaths.map((path) =>
				this.app.vault.adapter.readBinary(path),
			),
		);

		const wavBuffer = assembleWavFromPcmSegments(
			segments,
			target.pcmChannels,
			target.pcmSampleRate,
		);

		await this.app.vault.createBinary(filePath, wavBuffer);

		const failedPaths = await removeTemporaryArtifacts(
			target.segmentPaths,
			'Failed to remove PCM segment file after WAV assembly',
			this.app,
		);
		if (failedPaths.length > 0) {
			// Keep the assembled file: it already contains all captured
			// audio, while segments that were removed exist nowhere else.
			// Rolling it back would lose their audio permanently and leave
			// part bookkeeping pointing at missing segment files.
			console.error(
				`${PLUGIN_LOG_PREFIX} Temporary segment files could not be removed:`,
				failedPaths,
			);
			new Notice(
				`Recording saved, but temporary files could not be removed: ${failedPaths.join(', ')}`,
			);
		}
	}

	private async buildPcmTrackWavBlob(
		target: RecordingTarget,
	): Promise<Blob | null> {
		if (
			target.segmentPaths.length === 0 &&
			target.pcmBuffers.length === 0
		) {
			return null;
		}

		await this.writeQueue.flushPcmBuffer(target);

		if (target.segmentPaths.length === 0) {
			return null;
		}

		const segments = await Promise.all(
			target.segmentPaths.map((path) =>
				this.app.vault.adapter.readBinary(path),
			),
		);

		const wavBuffer = assembleWavFromPcmSegments(
			segments,
			target.pcmChannels,
			target.pcmSampleRate,
		);

		return new Blob([wavBuffer], { type: 'audio/wav' });
	}

	private async buildTrackBlob(
		target: RecordingTarget,
	): Promise<Blob | null> {
		if (
			target.segmentPaths.length === 0 &&
			target.bufferedChunks.length === 0
		) {
			return null;
		}

		const type = getRecorderMediaType(this.activeRecorderFormat);
		const segmentBuffers = await Promise.all(
			target.segmentPaths.map((path) =>
				this.app.vault.adapter.readBinary(path),
			),
		);

		return new Blob([...segmentBuffers, ...target.bufferedChunks], {
			type,
		});
	}

	/**
	 * Builds the final track file name, appending the part suffix when
	 * the session was auto-split (the residual after the last rotation
	 * becomes the next part number). Uses the base name snapshotted at
	 * session start so the residual matches its sibling part files even
	 * when the file prefix setting changed mid-recording.
	 * @param target - Recording target
	 * @param extension - File extension without the dot
	 */
	private buildTrackFileName(
		target: RecordingTarget,
		extension: string,
	): string {
		if (target.partIndex > 0) {
			return buildPartFileName(
				target.fileBaseName,
				this.sessionPartSuffix,
				target.partIndex + 1,
				extension,
			);
		}
		return `${target.fileBaseName}.${extension}`;
	}

	private async finalizeTrackFiles(
		target: RecordingTarget,
	): Promise<string[]> {
		const fileLinks: string[] = [];
		if (this.isMobileRecording) {
			await this.writeQueue.flushChunkBuffer(target);
			fileLinks.push(...target.segmentPaths);
			return fileLinks;
		}

		if (this.isWavPcmRecording) {
			this.updateSaveProgress(20, 'Flushing buffers...');
			await this.writeQueue.flushPcmBuffer(target);
			if (target.segmentPaths.length === 0) {
				return fileLinks;
			}
			this.updateSaveProgress(40, 'Assembling audio...');
			const fileName = this.buildTrackFileName(target, FORMAT_WAV);
			const filePath = await resolveUniquePath(
				fileName,
				this.app,
				this.settings,
			);
			this.updateSaveProgress(60, 'Writing file...');
			await this.assembleWavFile(target, filePath);
			fileLinks.push(filePath);
			return fileLinks;
		}

		const fileName = this.buildTrackFileName(
			target,
			this.sessionOutputFormat,
		);
		const filePath = await this.finalizeMediaTrackToFile(
			target,
			fileName,
			true,
		);
		if (filePath) {
			fileLinks.push(filePath);
		}
		return fileLinks;
	}

	/**
	 * Finalizes buffered MediaRecorder data of one track into a final
	 * audio file: flushes the chunk buffer to segment files and hands
	 * them to finalizeSegmentsToFile. Used at stop; part rotation
	 * finalizes detached snapshots directly instead.
	 * @param target - Recording target to finalize
	 * @param fileName - Final file name
	 * @param reportProgress - Whether to emit save-progress status updates
	 * @returns Final file path, or null when no audio data is buffered
	 */
	private async finalizeMediaTrackToFile(
		target: RecordingTarget,
		fileName: string,
		reportProgress: boolean = false,
	): Promise<string | null> {
		await this.writeQueue.flushChunkBuffer(target);
		const filePath = await this.finalizeSegmentsToFile(
			target.segmentPaths,
			fileName,
			reportProgress,
		);
		if (filePath) {
			target.segmentPaths = [];
			target.segmentIndex = 0;
		}
		return filePath;
	}

	/**
	 * Transcodes and writes a list of raw segment files into one final
	 * audio file in the session output format, then removes the
	 * temporary segments (segments that cannot be removed are reported
	 * and left on disk; the final file is always kept). Operates on an
	 * explicit segment list so part rotation can finalize a detached
	 * snapshot while the next part is recording.
	 * @param segmentPaths - Segment files in capture order
	 * @param fileName - Final file name
	 * @param reportProgress - Whether to emit save-progress status
	 * updates (must stay false during rotation: the Saving status would
	 * tear down the status bar recording controls)
	 * @returns Final file path, or null when the segments hold no data
	 */
	private async finalizeSegmentsToFile(
		segmentPaths: string[],
		fileName: string,
		reportProgress: boolean = false,
	): Promise<string | null> {
		if (segmentPaths.length === 0) {
			return null;
		}
		const segmentBuffers = await Promise.all(
			segmentPaths.map((path) => this.app.vault.adapter.readBinary(path)),
		);
		const blob = new Blob(segmentBuffers, {
			type: getRecorderMediaType(this.activeRecorderFormat),
		});
		if (blob.size === 0) {
			return null;
		}

		const outputFormat = this.sessionOutputFormat;
		const filePath = await resolveUniquePath(
			fileName,
			this.app,
			this.settings,
		);

		if (outputFormat === FORMAT_WAV) {
			if (reportProgress) {
				this.updateSaveProgress(40, 'Assembling audio...');
			}
			const wavBlob = await convertBlobToWav(blob);
			if (reportProgress) {
				this.updateSaveProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await wavBlob.arrayBuffer(),
			);
		} else if (
			isOfflineOnlyFormat(outputFormat, this.activeRecorderFormat)
		) {
			// Offline-only format: decode intermediate blob, re-encode to target
			if (reportProgress) {
				this.updateSaveProgress(40, 'Encoding audio...');
			}
			const outputBlob = await convertBlobToFormat(
				blob,
				outputFormat,
				this.sessionBitrate,
				(percent) => {
					if (reportProgress) {
						this.updateSaveProgress(
							40 + Math.round(percent * 0.2),
							'Encoding audio...',
						);
					}
				},
				// The intermediate blob was recorded at the session
				// bitrate, so a codec-matching remux preserves it
				{ allowRemux: true },
			);
			if (reportProgress) {
				this.updateSaveProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await outputBlob.arrayBuffer(),
			);
		} else {
			if (reportProgress) {
				this.updateSaveProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await blob.arrayBuffer(),
			);
		}

		if (reportProgress) {
			this.updateSaveProgress(80, 'Cleaning up...');
		}
		const failedCleanupPaths = await removeTemporaryArtifacts(
			segmentPaths,
			'Failed to remove segment file after finalization',
			this.app,
		);
		if (failedCleanupPaths.length > 0) {
			// Keep the final file: it already contains all captured audio,
			// while segments that were removed exist nowhere else. Rolling
			// it back would lose their audio permanently and leave part
			// bookkeeping pointing at missing segment files.
			console.error(
				`${PLUGIN_LOG_PREFIX} Temporary segment files could not be removed:`,
				failedCleanupPaths,
			);
			new Notice(
				`Recording saved, but temporary files could not be removed: ${failedCleanupPaths.join(', ')}`,
			);
		}

		return filePath;
	}
}
