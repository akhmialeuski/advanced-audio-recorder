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
	MOBILE_BUFFER_LIMIT_BYTES,
	PCM_FLUSH_THRESHOLD_BYTES,
	DESKTOP_FLUSH_THRESHOLD_BYTES,
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	MIN_SPLIT_CHUNK_MINUTES,
} from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	validateRecordingCapability,
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
	buildOutputBlob,
	mergeAudioTracks,
} from './AudioFormatConverter';
import {
	buildPartFileName,
	computePcmPartLimitBytes,
	sanitizePartSuffix,
} from './AudioSplitter';
import { captureInsertionContext, insertFileLinks } from './NoteInserter';

/** Milliseconds in one minute. */
const MS_PER_MINUTE = 60_000;

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
	/** Active (unpaused) milliseconds accumulated in the current part. */
	private partActiveMs: number = 0;
	/** Timestamp of the last start/resume/rotation for active-time tracking. */
	private activeAnchor: number = 0;
	/** In-flight MediaRecorder part rotation, if any. */
	private rotationPromise: Promise<void> | null = null;

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

			this.snapshotSplitSession(streams.length);

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
			this.handleStartRecordingError(error);
		}
	}

	/**
	 * Snapshots auto-split settings for the current session so that
	 * settings changes made mid-recording do not alter its behavior.
	 * Auto-split is skipped for merged multi-track output because the
	 * tracks are mixed only once at stop.
	 * @param streamCount - Number of acquired audio streams
	 */
	private snapshotSplitSession(streamCount: number): void {
		this.sessionPartMinutes = Math.max(
			MIN_SPLIT_CHUNK_MINUTES,
			Math.floor(this.settings.splitChunkMinutes),
		);
		this.sessionPartSuffix = sanitizePartSuffix(
			this.settings.splitPartSuffix,
		);
		this.sessionSplitEnabled =
			this.settings.autoSplitEnabled && !this.isMobileRecording;

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
	 * names from device IDs or sequential numbering.
	 * @param count - Number of targets to create
	 */
	private async createChunkTargets(
		count: number,
	): Promise<RecordingTarget[]> {
		return Promise.all(
			Array.from({ length: count }, async (_, index) => {
				const trackInfo = this.trackOrder[index];
				const trackNumber = trackInfo?.trackNumber ?? index + 1;
				const deviceId = trackInfo?.deviceId;
				const sourceName =
					this.settings.useSourceNamesForTracks && deviceId
						? await getAudioSourceName(deviceId)
						: `Track${trackNumber}`;
				const fileBaseName = `${this.settings.filePrefix}-${sourceName}-${this.recordingTimestamp}`;
				return {
					fileBaseName,
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
				};
			}),
		);
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
					audioBitsPerSecond: this.settings.bitrate,
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
		// Let an in-flight part rotation finish before tearing down,
		// otherwise the recorders it recreates would leak
		if (this.rotationPromise) {
			await this.rotationPromise;
		}

		const recordersToStop = [...this.recorders];
		const pcmRecordersToStop = [...this.pcmRecorders];
		const streamsToStop = [...this.streams];

		try {
			if (this.isWavPcmRecording) {
				await Promise.all(
					pcmRecordersToStop.map((recorder) => recorder.stop()),
				);
			} else {
				await Promise.all(
					recordersToStop.map(
						(recorder) =>
							new Promise<void>((resolve) => {
								recorder.addEventListener(
									'stop',
									() => resolve(),
									{ once: true },
								);
								recorder.stop();
							}),
					),
				);
			}

			await Promise.all(
				this.chunkTargets.map((target) => target.pendingWrite),
			);

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
			stopAllStreams(streamsToStop);
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
			this.setStatus(RecordingStatus.Idle);
		}
	}

	/**
	 * Toggles pause/resume state.
	 */
	togglePauseResume(): void {
		if (this.status === RecordingStatus.Recording) {
			if (this.isWavPcmRecording) {
				this.pcmRecorders.forEach((recorder) => recorder.pause());
			} else {
				this.recorders.forEach((recorder) => recorder.pause());
			}
			// Freeze active-time accounting used by auto-split rotation
			this.partActiveMs += Date.now() - this.activeAnchor;
			this.setStatus(RecordingStatus.Paused);
			new Notice('Recording paused');
		} else if (this.status === RecordingStatus.Paused) {
			if (this.isWavPcmRecording) {
				this.pcmRecorders.forEach((recorder) => recorder.resume());
			} else {
				this.recorders.forEach((recorder) => recorder.resume());
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

	private updateSaveProgress(percent: number, description: string): void {
		this.setStatus(RecordingStatus.Saving, { percent, description });
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
				const paths = await this.finalizeTrackFiles(target, timestamp);
				fileLinks.push(...target.partPaths, ...paths);
			} else {
				if (!this.isWavPcmRecording) {
					await Promise.all(
						this.chunkTargets.map((target) =>
							this.flushChunkBuffer(target),
						),
					);
				}
				if (this.isWavPcmRecording) {
					await Promise.all(
						this.chunkTargets.map((target) =>
							this.flushPcmBuffer(target),
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
				}
			}
		} else {
			for (let i = 0; i < this.chunkTargets.length; i++) {
				const target = this.chunkTargets[i];
				const paths = await this.finalizeTrackFiles(target, timestamp);
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

		const enqueue = async (): Promise<void> => {
			target.bufferedChunks.push(data);
			target.bufferedBytes += data.size;
			if (target.bufferedBytes >= flushThreshold) {
				await this.flushChunkBuffer(target);
			}
		};

		target.pendingWrite = target.pendingWrite.then(enqueue);
		await target.pendingWrite;

		// Rotation spans all tracks and restarts the recorders, so it runs
		// outside the per-target pendingWrite chain, guarded against reentry
		if (this.shouldRotateMediaParts()) {
			this.rotationPromise = this.rotateMediaRecorderParts().finally(
				() => {
					this.rotationPromise = null;
				},
			);
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

		const enqueue = async (): Promise<void> => {
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
				await this.flushPcmBuffer(target);
			}
		};

		target.pendingWrite = target.pendingWrite.then(enqueue);
		await target.pendingWrite;
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
		let carry: ArrayBuffer | null = null;
		if (overshoot > 0 && target.pcmBuffers.length > 0) {
			const last = target.pcmBuffers[target.pcmBuffers.length - 1];
			const keepBytes = last.byteLength - overshoot;
			target.pcmBuffers[target.pcmBuffers.length - 1] = last.slice(
				0,
				keepBytes,
			);
			carry = last.slice(keepBytes);
		}

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
			await this.flushPcmBuffer(target);
			if (target.segmentPaths.length > 0) {
				await this.assembleWavFile(target, filePath);
				target.partPaths.push(filePath);
				this.debugLogger.log('Auto-split part saved', { filePath });
				new Notice(`Recording part ${String(target.partIndex)} saved`);
			}
			target.segmentPaths = [];
			target.segmentIndex = 0;
		} catch (error) {
			// Keep recording: data stays in segments and lands in the next part
			target.partIndex -= 1;
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
				error,
			);
			new Notice(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
		} finally {
			target.pcmBuffers = carry ? [carry] : [];
			target.pcmBufferedBytes = carry ? carry.byteLength : 0;
			target.partPcmBytes = carry ? carry.byteLength : 0;
		}
	}

	/**
	 * Rotates MediaRecorder-based recording at an auto-split boundary:
	 * stops the recorders to obtain a complete container, finalizes the
	 * buffered data as a part file per track, and restarts the recorders
	 * on the same streams. The recording status stays Recording the whole
	 * time. Errors are contained so the session keeps recording.
	 */
	private async rotateMediaRecorderParts(): Promise<void> {
		try {
			const recordersToStop = [...this.recorders];
			await Promise.all(
				recordersToStop.map(
					(recorder) =>
						new Promise<void>((resolve) => {
							recorder.addEventListener('stop', () => resolve(), {
								once: true,
							});
							recorder.stop();
						}),
				),
			);
			await Promise.all(this.chunkTargets.map((t) => t.pendingWrite));

			for (const target of this.chunkTargets) {
				target.partIndex += 1;
				try {
					const fileName = buildPartFileName(
						target.fileBaseName,
						this.sessionPartSuffix,
						target.partIndex,
						this.settings.recordingFormat,
					);
					const filePath = await this.finalizeMediaTrackToFile(
						target,
						fileName,
					);
					if (filePath) {
						target.partPaths.push(filePath);
						this.debugLogger.log('Auto-split part saved', {
							filePath,
						});
						new Notice(
							`Recording part ${String(target.partIndex)} saved`,
						);
					} else {
						target.partIndex -= 1;
					}
				} catch (error) {
					// Keep recording: segments stay on disk for the next part
					target.partIndex -= 1;
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
						error,
					);
					new Notice(
						'Failed to save recording part. Recording continues; data is kept for the next part.',
					);
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
				this.status === RecordingStatus.Recording ||
				this.status === RecordingStatus.Paused
			) {
				this.createAndStartMediaRecorders();
				if (this.status === RecordingStatus.Paused) {
					this.recorders.forEach((recorder) => recorder.pause());
				}
			}
			this.partActiveMs = 0;
			this.activeAnchor = Date.now();
		}
	}

	private async flushPcmBuffer(target: RecordingTarget): Promise<void> {
		if (target.pcmBuffers.length === 0) {
			return;
		}
		target.segmentIndex += 1;
		const segmentName = `${target.fileBaseName}-pcm-part${String(target.segmentIndex)}.tmp`;
		const segmentPath = await resolveUniquePath(
			segmentName,
			this.app,
			this.settings,
		);

		const totalSize = target.pcmBuffers.reduce(
			(sum, buf) => sum + buf.byteLength,
			0,
		);
		const merged = new Uint8Array(totalSize);
		let offset = 0;
		for (const buf of target.pcmBuffers) {
			merged.set(new Uint8Array(buf), offset);
			offset += buf.byteLength;
		}

		await this.app.vault.createBinary(segmentPath, merged.buffer);
		target.segmentPaths.push(segmentPath);
		target.pcmBuffers = [];
		target.pcmBufferedBytes = 0;
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
			await rollbackFinalFile(
				filePath,
				'Failed to rollback assembled WAV file',
				this.app,
			);
			throw new Error(
				`Temporary recording artifacts were kept for recovery: ${failedPaths.join(', ')}`,
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

		await this.flushPcmBuffer(target);

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

	private async flushChunkBuffer(target: RecordingTarget): Promise<void> {
		if (target.bufferedChunks.length === 0) {
			return;
		}
		target.segmentIndex += 1;

		if (this.isMobileRecording) {
			// Mobile: encode/convert chunks via buildOutputBlob pipeline
			const segmentName = `${target.fileBaseName}-part${String(
				target.segmentIndex,
			)}.${this.settings.recordingFormat}`;
			const segmentPath = await resolveUniquePath(
				segmentName,
				this.app,
				this.settings,
			);
			const outputBlob = await buildOutputBlob(
				target.bufferedChunks,
				getRecorderMediaType(this.activeRecorderFormat),
				this.settings.recordingFormat,
			);
			await this.app.vault.createBinary(
				segmentPath,
				await outputBlob.arrayBuffer(),
			);
			target.segmentPaths.push(segmentPath);
		} else {
			// Desktop: write raw chunks as a single segment file
			const segmentName = `${target.fileBaseName}-part${String(target.segmentIndex)}.${this.activeRecorderFormat}.tmp`;
			const segmentPath = await resolveUniquePath(
				segmentName,
				this.app,
				this.settings,
			);
			const combined = new Blob(target.bufferedChunks, {
				type: getRecorderMediaType(this.activeRecorderFormat),
			});
			await this.app.vault.createBinary(
				segmentPath,
				await combined.arrayBuffer(),
			);
			target.segmentPaths.push(segmentPath);
		}

		target.bufferedChunks = [];
		target.bufferedBytes = 0;
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
	 * becomes the next part number).
	 * @param target - Recording target
	 * @param timestamp - Recording timestamp string
	 * @param extension - File extension without the dot
	 */
	private buildTrackFileName(
		target: RecordingTarget,
		timestamp: string,
		extension: string,
	): string {
		const baseName = `${this.settings.filePrefix}-${target.sourceName}-${timestamp}`;
		if (target.partIndex > 0) {
			return buildPartFileName(
				baseName,
				this.sessionPartSuffix,
				target.partIndex + 1,
				extension,
			);
		}
		return `${baseName}.${extension}`;
	}

	private async finalizeTrackFiles(
		target: RecordingTarget,
		timestamp: string,
	): Promise<string[]> {
		const fileLinks: string[] = [];
		if (this.isMobileRecording) {
			await this.flushChunkBuffer(target);
			fileLinks.push(...target.segmentPaths);
			return fileLinks;
		}

		if (this.isWavPcmRecording) {
			this.updateSaveProgress(20, 'Flushing buffers...');
			await this.flushPcmBuffer(target);
			if (target.segmentPaths.length === 0) {
				return fileLinks;
			}
			this.updateSaveProgress(40, 'Assembling audio...');
			const fileName = this.buildTrackFileName(
				target,
				timestamp,
				FORMAT_WAV,
			);
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
			timestamp,
			this.settings.recordingFormat,
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
	 * audio file: flushes buffers, concatenates segments, converts to
	 * the configured output format, writes the file, and removes the
	 * temporary segments (rolling the file back when cleanup fails).
	 * Used both at stop and at auto-split part rotation.
	 * @param target - Recording target to finalize
	 * @param fileName - Final file name
	 * @param reportProgress - Whether to emit save-progress status
	 * updates (must stay false during rotation: the Saving status would
	 * tear down the status bar recording controls)
	 * @returns Final file path, or null when no audio data is buffered
	 */
	private async finalizeMediaTrackToFile(
		target: RecordingTarget,
		fileName: string,
		reportProgress: boolean = false,
	): Promise<string | null> {
		await this.flushChunkBuffer(target);
		const blob = await this.buildTrackBlob(target);
		if (!blob || blob.size === 0) {
			return null;
		}

		const outputFormat = this.settings.recordingFormat;
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
				this.settings.bitrate,
				(percent) => {
					if (reportProgress) {
						this.updateSaveProgress(
							40 + Math.round(percent * 0.2),
							'Encoding audio...',
						);
					}
				},
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
			target.segmentPaths,
			'Failed to remove segment file after finalization',
			this.app,
		);
		if (failedCleanupPaths.length > 0) {
			await rollbackFinalFile(
				filePath,
				'Failed to rollback finalized track',
				this.app,
			);
			throw new Error(
				`Temporary recording artifacts were kept for recovery: ${failedCleanupPaths.join(', ')}`,
			);
		}

		target.segmentPaths = [];
		target.segmentIndex = 0;
		return filePath;
	}
}
