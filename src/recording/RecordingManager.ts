/**
 * Recording manager for handling audio recording lifecycle.
 * @module recording/RecordingManager
 */

import { MarkdownView, normalizePath, Notice, Platform } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type { InsertionContext, SaveProgress } from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
	validateSelectedDevices,
} from './AudioStreamHandler';
import { bufferToWave, assembleWavFromPcmSegments } from './WavEncoder';
import { encodeAudioBuffer, isOfflineEncodingSupported } from './AudioEncoder';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	validateRecordingCapability,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_WAV,
} from './AudioCapabilityDetector';
import { PcmStreamRecorder } from './PcmStreamRecorder';

type RecordingTarget = {
	fileBaseName: string;
	sourceName: string;
	bufferedChunks: Blob[];
	bufferedBytes: number;
	segmentIndex: number;
	segmentPaths: string[];
	pendingWrite: Promise<void>;
	pcmBuffers: ArrayBuffer[];
	pcmBufferedBytes: number;
	pcmChannels: number;
	pcmSampleRate: number;
};

const CHUNK_TIMESLICE_MS = 5000;
const MOBILE_BUFFER_LIMIT_BYTES = 50 * 1024 * 1024;
const PCM_FLUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;
const MIME_TYPE_AUDIO_PREFIX = 'audio/';

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
				const { recorderFormat, mimeType } =
					this.resolveRecorderFormat();
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

			this.captureInsertionContext();
			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording started');
		} catch (error) {
			this.handleStartRecordingError(error);
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
		const mimeType = buildMimeType(this.activeRecorderFormat);
		this.recorders = this.streams.map(
			(stream) =>
				new MediaRecorder(stream, {
					mimeType,
					audioBitsPerSecond: this.settings.bitrate,
				}),
		);
		this.chunkTargets = await this.createChunkTargets(
			this.recorders.length,
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
			this.setStatus(RecordingStatus.Paused);
			new Notice('Recording paused');
		} else if (this.status === RecordingStatus.Paused) {
			if (this.isWavPcmRecording) {
				this.pcmRecorders.forEach((recorder) => recorder.resume());
			} else {
				this.recorders.forEach((recorder) => recorder.resume());
			}
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
				const paths = await this.finalizeTrackFiles(
					this.chunkTargets[0],
					timestamp,
				);
				fileLinks.push(...paths);
			} else {
				if (this.isMobileRecording) {
					await Promise.all(
						this.chunkTargets.map((target) =>
							this.flushMobileBuffer(target),
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
				const mergedAudio = await this.mergeAudioTracks();
				this.updateSaveProgress(60, 'Writing file...');
				const fileName = `${this.settings.filePrefix}-multitrack-${timestamp}.${targetFormat}`;
				const filePath = await this.saveAudioFile(
					mergedAudio,
					fileName,
				);
				if (filePath) {
					this.updateSaveProgress(80, 'Cleaning up...');
					const failedCleanupPaths =
						await this.cleanupIntermediateFiles();
					if (failedCleanupPaths.length > 0) {
						await this.rollbackFinalFile(
							filePath,
							'Failed to finalize recording cleanup for merged output',
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
				const paths = await this.finalizeTrackFiles(
					this.chunkTargets[i],
					timestamp,
				);
				fileLinks.push(...paths);
			}
		}

		if (fileLinks.length > 0) {
			this.insertFileLinks(fileLinks);
			new Notice(`Saved ${String(fileLinks.length)} audio file(s)`);
		} else {
			new Notice('No audio data recorded');
		}
	}

	private async mergeAudioTracks(): Promise<Blob> {
		const audioContext = new AudioContext();
		const buffers = await Promise.all(
			this.chunkTargets.map(async (target) => {
				const blob = this.isWavPcmRecording
					? await this.buildPcmTrackWavBlob(target)
					: await this.buildTrackBlob(target);
				if (!blob) {
					return null;
				}
				const arrayBuffer = await blob.arrayBuffer();
				return audioContext.decodeAudioData(arrayBuffer);
			}),
		);

		const validBuffers = buffers.filter(
			(buffer): buffer is AudioBuffer => buffer !== null,
		);
		if (validBuffers.length === 0) {
			throw new Error('No audio data recorded');
		}

		const longestDuration = Math.max(
			...validBuffers.map((buffer) => buffer.duration),
		);
		const offlineContext = new OfflineAudioContext(
			2,
			audioContext.sampleRate * longestDuration,
			audioContext.sampleRate,
		);

		validBuffers.forEach((buffer) => {
			const source = offlineContext.createBufferSource();
			source.buffer = buffer;
			source.connect(offlineContext.destination);
			source.start(0);
		});

		const renderedBuffer = await offlineContext.startRendering();
		await audioContext.close();

		const targetFormat = this.settings.recordingFormat;
		if (
			targetFormat !== FORMAT_WAV &&
			isOfflineEncodingSupported(targetFormat)
		) {
			return encodeAudioBuffer(
				renderedBuffer,
				{
					format: targetFormat,
					bitrate: this.settings.bitrate,
				},
				(percent) => {
					this.updateSaveProgress(
						40 + Math.round(percent * 0.2),
						'Encoding audio...',
					);
				},
			);
		}
		return bufferToWave(renderedBuffer, renderedBuffer.length);
	}

	private async handleChunk(index: number, data: Blob): Promise<void> {
		const target = this.chunkTargets[index];
		if (!target) {
			return;
		}
		this.totalChunks += 1;
		const enqueue = async (): Promise<void> => {
			if (this.isMobileRecording) {
				target.bufferedChunks.push(data);
				target.bufferedBytes += data.size;
				if (target.bufferedBytes >= MOBILE_BUFFER_LIMIT_BYTES) {
					await this.flushMobileBuffer(target);
				}
				return;
			}

			try {
				target.segmentIndex += 1;
				const segmentName = `${target.fileBaseName}-part${String(target.segmentIndex)}.${this.activeRecorderFormat}.tmp`;
				const segmentPath = await this.resolveUniquePath(segmentName);
				const arrayBuffer = await data.arrayBuffer();
				await this.app.vault.createBinary(segmentPath, arrayBuffer);
				target.segmentPaths.push(segmentPath);
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to write segment:`,
					error,
				);
				new Notice(
					'Failed to save recording chunk. Check console for details.',
				);
			}
		};

		target.pendingWrite = target.pendingWrite.then(enqueue);
		await target.pendingWrite;
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
			if (target.pcmBufferedBytes >= PCM_FLUSH_THRESHOLD_BYTES) {
				await this.flushPcmBuffer(target);
			}
		};

		target.pendingWrite = target.pendingWrite.then(enqueue);
		await target.pendingWrite;
	}

	private async flushPcmBuffer(target: RecordingTarget): Promise<void> {
		if (target.pcmBuffers.length === 0) {
			return;
		}
		target.segmentIndex += 1;
		const segmentName = `${target.fileBaseName}-pcm-part${String(target.segmentIndex)}.tmp`;
		const segmentPath = await this.resolveUniquePath(segmentName);

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

		const failedPaths = await this.removeTemporaryArtifacts(
			target.segmentPaths,
			'Failed to remove PCM segment file after WAV assembly',
		);
		if (failedPaths.length > 0) {
			await this.rollbackFinalFile(
				filePath,
				'Failed to rollback assembled WAV file',
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

	private async flushMobileBuffer(target: RecordingTarget): Promise<void> {
		if (target.bufferedChunks.length === 0) {
			return;
		}
		target.segmentIndex += 1;
		const segmentName = `${target.fileBaseName}-part${String(
			target.segmentIndex,
		)}.${this.settings.recordingFormat}`;
		const segmentPath = await this.resolveUniquePath(segmentName);
		const outputBlob = await this.buildOutputBlob(target.bufferedChunks);
		await this.app.vault.createBinary(
			segmentPath,
			await outputBlob.arrayBuffer(),
		);
		target.segmentPaths.push(segmentPath);
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

		const type = this.getRecorderMediaType();
		const segmentBuffers = await Promise.all(
			target.segmentPaths.map((path) =>
				this.app.vault.adapter.readBinary(path),
			),
		);

		return new Blob([...segmentBuffers, ...target.bufferedChunks], {
			type,
		});
	}

	private async cleanupIntermediateFiles(): Promise<string[]> {
		const intermediatePaths = this.chunkTargets.flatMap(
			(target) => target.segmentPaths,
		);

		return this.removeTemporaryArtifacts(
			intermediatePaths,
			'Failed to remove intermediate recording file',
		);
	}

	private async removeTemporaryArtifacts(
		paths: string[],
		logContext: string,
	): Promise<string[]> {
		const failedPaths: string[] = [];

		await Promise.all(
			paths.map(async (path) => {
				try {
					await this.app.vault.adapter.remove(path);
				} catch (error) {
					failedPaths.push(path);
					console.warn(`${PLUGIN_LOG_PREFIX} ${logContext}:`, {
						path,
						error,
					});
				}
			}),
		);

		return failedPaths;
	}

	private async rollbackFinalFile(
		filePath: string,
		logContext: string,
	): Promise<void> {
		try {
			await this.app.vault.adapter.remove(filePath);
		} catch (error) {
			console.error(`${PLUGIN_LOG_PREFIX} ${logContext}:`, {
				filePath,
				error,
			});
		}
	}

	private async finalizeTrackFiles(
		target: RecordingTarget,
		timestamp: string,
	): Promise<string[]> {
		const fileLinks: string[] = [];
		if (this.isMobileRecording) {
			await this.flushMobileBuffer(target);
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
			const fileName = `${this.settings.filePrefix}-${target.sourceName}-${timestamp}.wav`;
			const filePath = await this.resolveUniquePath(fileName);
			this.updateSaveProgress(60, 'Writing file...');
			await this.assembleWavFile(target, filePath);
			fileLinks.push(filePath);
			return fileLinks;
		}

		const blob = await this.buildTrackBlob(target);
		if (!blob || blob.size === 0) {
			return fileLinks;
		}

		const outputFormat = this.settings.recordingFormat;
		const fileName = `${this.settings.filePrefix}-${target.sourceName}-${timestamp}.${outputFormat}`;
		const filePath = await this.resolveUniquePath(fileName);

		if (this.settings.recordingFormat === FORMAT_WAV) {
			this.updateSaveProgress(40, 'Assembling audio...');
			const wavBlob = await this.convertBlobToWav(blob);
			this.updateSaveProgress(60, 'Writing file...');
			await this.app.vault.createBinary(
				filePath,
				await wavBlob.arrayBuffer(),
			);
		} else if (this.isOfflineOnlyFormat(outputFormat)) {
			// Offline-only format: decode intermediate blob, re-encode to target
			this.updateSaveProgress(40, 'Decoding intermediate audio...');
			const outputBlob = await this.convertBlobToFormat(
				blob,
				outputFormat,
			);
			this.updateSaveProgress(60, 'Writing file...');
			await this.app.vault.createBinary(
				filePath,
				await outputBlob.arrayBuffer(),
			);
		} else {
			this.updateSaveProgress(60, 'Writing file...');
			await this.app.vault.createBinary(
				filePath,
				await blob.arrayBuffer(),
			);
		}

		this.updateSaveProgress(80, 'Cleaning up...');
		const failedCleanupPaths = await this.removeTemporaryArtifacts(
			target.segmentPaths,
			'Failed to remove segment file after finalization',
		);
		if (failedCleanupPaths.length > 0) {
			await this.rollbackFinalFile(
				filePath,
				'Failed to rollback finalized track',
			);
			throw new Error(
				`Temporary recording artifacts were kept for recovery: ${failedCleanupPaths.join(', ')}`,
			);
		}

		fileLinks.push(filePath);
		return fileLinks;
	}

	private getActiveFileDirectory(): string {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || !activeFile.path.toLowerCase().endsWith('.md')) {
			return '';
		}
		const segments = activeFile.path.split('/');
		segments.pop();
		return segments.join('/');
	}

	private getBaseSaveDirectory(): string {
		if (this.settings.saveNearActiveFile) {
			const activeDirectory = this.getActiveFileDirectory();
			if (this.settings.activeFileSubfolder.trim() === '') {
				return activeDirectory;
			}
			return normalizePath(
				`${activeDirectory}/${this.settings.activeFileSubfolder}`,
			);
		}
		return this.settings.saveFolder;
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const normalizedPath = normalizePath(path).trim();
		if (!normalizedPath) {
			return;
		}
		if (await this.app.vault.adapter.exists(normalizedPath)) {
			return;
		}
		await this.app.vault.createFolder(normalizedPath);
	}

	private async resolveUniquePath(fileName: string): Promise<string> {
		let sanitizedFileName = fileName.replace(/[\\/:*?"<>|]/g, '-');
		const baseDirectory = this.getBaseSaveDirectory();
		await this.ensureFolderExists(baseDirectory);
		let filePath = normalizePath(`${baseDirectory}/${sanitizedFileName}`);

		let counter = 1;
		while (await this.app.vault.adapter.exists(filePath)) {
			const parts = sanitizedFileName.split('.');
			const ext = parts.pop() ?? '';
			const name = parts.join('.');
			sanitizedFileName = `${name}_${String(counter)}.${ext}`;
			filePath = normalizePath(`${baseDirectory}/${sanitizedFileName}`);
			counter++;
		}

		return filePath;
	}

	private async saveAudioFile(
		audioBlob: Blob,
		fileName: string,
	): Promise<string | null> {
		if (audioBlob.size === 0) {
			console.debug(
				`${PLUGIN_LOG_PREFIX} Skipping empty file: ${fileName}`,
			);
			return null;
		}

		const arrayBuffer = await audioBlob.arrayBuffer();
		const filePath = await this.resolveUniquePath(fileName);

		await this.app.vault.createBinary(filePath, arrayBuffer);
		return filePath;
	}

	private resolveRecorderFormat(): {
		recorderFormat: string;
		mimeType: string;
	} {
		const outputFormat = this.settings.recordingFormat.toLowerCase();

		// Check if MediaRecorder natively supports this format
		const nativeMime = buildMimeType(outputFormat);
		if (
			outputFormat !== FORMAT_WAV &&
			MediaRecorder.isTypeSupported(nativeMime)
		) {
			return { recorderFormat: outputFormat, mimeType: nativeMime };
		}

		// WAV and offline-only formats need an intermediate compressed format
		const preferredCompressedFormats = [FORMAT_WEBM, FORMAT_OGG];
		for (const format of preferredCompressedFormats) {
			const mimeType = buildMimeType(format);
			if (MediaRecorder.isTypeSupported(mimeType)) {
				return { recorderFormat: format, mimeType };
			}
		}
		throw new Error(
			`Output format "${outputFormat}" requires an intermediate compressed format, but neither WebM nor OGG is supported in this browser.`,
		);
	}

	private getRecorderMediaType(): string {
		return `${MIME_TYPE_AUDIO_PREFIX}${this.activeRecorderFormat}`;
	}

	private async buildOutputBlob(chunks: Blob[]): Promise<Blob> {
		const recordedBlob = new Blob(chunks, {
			type: this.getRecorderMediaType(),
		});
		const isWav = this.settings.recordingFormat === FORMAT_WAV;
		if (!isWav) {
			return recordedBlob;
		}
		return this.convertBlobToWav(recordedBlob);
	}

	private async convertBlobToWav(recordedBlob: Blob): Promise<Blob> {
		const audioContext = new AudioContext();
		try {
			const arrayBuffer = await recordedBlob.arrayBuffer();
			const decodedBuffer =
				await audioContext.decodeAudioData(arrayBuffer);
			return bufferToWave(decodedBuffer, decodedBuffer.length);
		} finally {
			await audioContext.close();
		}
	}

	/**
	 * Checks if a format requires offline encoding (not natively
	 * supported by MediaRecorder) and the recorder uses an intermediate format.
	 */
	private isOfflineOnlyFormat(format: string): boolean {
		return (
			format !== FORMAT_WAV &&
			this.activeRecorderFormat !== format &&
			isOfflineEncodingSupported(format)
		);
	}

	/**
	 * Decodes an intermediate blob and re-encodes it to the target format.
	 */
	private async convertBlobToFormat(
		recordedBlob: Blob,
		targetFormat: string,
	): Promise<Blob> {
		const audioContext = new AudioContext();
		try {
			const arrayBuffer = await recordedBlob.arrayBuffer();
			const decodedBuffer =
				await audioContext.decodeAudioData(arrayBuffer);
			return encodeAudioBuffer(decodedBuffer, {
				format: targetFormat,
				bitrate: this.settings.bitrate,
			});
		} finally {
			await audioContext.close();
		}
	}

	/**
	 * Captures the active note and cursor position for later insertion.
	 */
	private captureInsertionContext(): void {
		if (!this.settings.insertAtOriginalPosition) {
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const filePath = view?.file?.path;
		const cursor = view?.editor?.getCursor();
		if (filePath && cursor) {
			this.insertionContext = {
				filePath,
				line: cursor.line,
				ch: cursor.ch,
			};
		} else {
			this.debugLogger.log(
				'Could not capture insertion context: no active Markdown view',
			);
		}
	}

	private insertFileLinks(fileLinks: string[]): void {
		const links = fileLinks
			.map((path) => {
				const fileName = path.split('/').pop() ?? path;
				return `![[${fileName}]]`;
			})
			.join('\n');

		if (this.insertionContext) {
			const leaf = this.app.workspace
				.getLeavesOfType('markdown')
				.find((l) => {
					const leafView = l.view;
					return (
						leafView instanceof MarkdownView &&
						leafView.file?.path === this.insertionContext?.filePath
					);
				});

			const leafView = leaf?.view;
			if (leafView instanceof MarkdownView) {
				const editor = leafView.editor;
				const pos = {
					line: this.insertionContext.line + 1,
					ch: 0,
				};
				editor.replaceRange(links + '\n', pos);
				return;
			}
		}

		// Fallback: insert into the currently active note
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = activeView?.editor;
		if (editor) {
			editor.replaceSelection(links);
		}
	}
}
