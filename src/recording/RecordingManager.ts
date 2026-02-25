/**
 * Recording manager for handling audio recording lifecycle.
 * @module recording/RecordingManager
 */

import { MarkdownView, normalizePath, Notice, Platform } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
	validateSelectedDevices,
} from './AudioStreamHandler';
import { bufferToWave } from './WavEncoder';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import {
	buildMimeType,
	validateRecordingCapability,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_WAV,
} from './AudioCapabilityDetector';

type RecordingTarget = {
	fileBaseName: string;
	sourceName: string;
	tempFilePath: string | null;
	bufferedChunks: Blob[];
	bufferedBytes: number;
	segmentIndex: number;
	segmentPaths: string[];
	pendingWrite: Promise<void>;
};

const CHUNK_TIMESLICE_MS = 5000;
const MOBILE_BUFFER_LIMIT_BYTES = 50 * 1024 * 1024;
const MIME_TYPE_AUDIO_PREFIX = 'audio/';

/**
 * Manages the audio recording lifecycle.
 */
export class RecordingManager {
	private recorders: MediaRecorder[] = [];
	private chunkTargets: RecordingTarget[] = [];
	private streams: MediaStream[] = [];
	private trackOrder: { trackNumber: number; deviceId: string }[] = [];
	private status: RecordingStatus = RecordingStatus.Idle;
	private onStatusChange: (status: RecordingStatus) => void;
	private debugLogger: DebugLogger;
	private recordingStartTime: number = 0;
	private recordingTimestamp: string | null = null;
	private totalChunks: number = 0;
	private isMobileRecording: boolean = false;
	private activeRecorderFormat: string = FORMAT_WEBM;

	/**
	 * Creates a new RecordingManager.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings
	 * @param onStatusChange - Callback for status changes
	 */
	constructor(
		private app: App,
		private settings: AudioRecorderSettings,
		onStatusChange: (status: RecordingStatus) => void,
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
			const { recorderFormat, mimeType } = this.resolveRecorderFormat();
			this.activeRecorderFormat = recorderFormat;
			this.debugLogger.logMimeType(mimeType);
			this.debugLogger.log('Recording format configuration', {
				outputFormat: this.settings.recordingFormat,
				recorderFormat,
				bitrate: this.settings.bitrate,
			});

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
			this.recorders = this.streams.map(
				(stream) =>
					new MediaRecorder(stream, {
						mimeType,
						audioBitsPerSecond: this.settings.bitrate,
					}),
			);
			this.recordingStartTime = Date.now();
			this.recordingTimestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, '-');
			this.totalChunks = 0;
			this.isMobileRecording = Platform.isMobileApp || Platform.isMobile;
			this.chunkTargets = await Promise.all(
				this.recorders.map(async (_recorder, index) => {
					const trackInfo = this.trackOrder[index];
					const trackNumber = trackInfo?.trackNumber ?? index + 1;
					const deviceId = trackInfo?.deviceId;
					const sourceName =
						this.settings.useSourceNamesForTracks && deviceId
							? await getAudioSourceName(deviceId)
							: `Track${trackNumber}`;
					const fileBaseName = `${this.settings.filePrefix}-${sourceName}-${this.recordingTimestamp}`;
					let tempFilePath: string | null = null;
					if (!this.isMobileRecording) {
						const tempName = `${fileBaseName}.partial.${this.activeRecorderFormat}`;
						tempFilePath = await this.resolveUniquePath(tempName);
						await this.app.vault.createBinary(
							tempFilePath,
							new ArrayBuffer(0),
						);
					}
					return {
						fileBaseName,
						sourceName,
						tempFilePath,
						bufferedChunks: [],
						bufferedBytes: 0,
						segmentIndex: 0,
						segmentPaths: [],
						pendingWrite: Promise.resolve(),
					};
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
					console.error(
						`${PLUGIN_LOG_PREFIX} Recorder error:`,
						event,
					);
					new Notice(
						'Recording error occurred. Check console for details.',
					);
				};
				recorder.start(CHUNK_TIMESLICE_MS);
			});

			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording started');
		} catch (error) {
			this.handleStartRecordingError(error);
		}
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
		const streamsToStop = [...this.streams];

		try {
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

			await Promise.all(
				this.chunkTargets.map((target) => target.pendingWrite),
			);

			const durationMs = Date.now() - this.recordingStartTime;
			this.debugLogger.logRecordingStats(durationMs, this.totalChunks);

			await this.saveRecording();
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
			this.chunkTargets = [];
			this.trackOrder = [];
			this.recordingTimestamp = null;
			this.totalChunks = 0;
			this.setStatus(RecordingStatus.Idle);
		}
	}

	/**
	 * Toggles pause/resume state.
	 */
	togglePauseResume(): void {
		if (this.status === RecordingStatus.Recording) {
			this.recorders.forEach((recorder) => recorder.pause());
			this.setStatus(RecordingStatus.Paused);
			new Notice('Recording paused');
		} else if (this.status === RecordingStatus.Paused) {
			this.recorders.forEach((recorder) => recorder.resume());
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
		this.chunkTargets = [];
		this.streams = [];
		this.recordingTimestamp = null;
		this.totalChunks = 0;
	}

	private setStatus(status: RecordingStatus): void {
		this.status = status;
		this.onStatusChange(status);
	}

	private async saveRecording(): Promise<void> {
		const timestamp =
			this.recordingTimestamp ??
			new Date().toISOString().replace(/[:.]/g, '-');
		const fileLinks: string[] = [];

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
				const mergedAudio =
					this.settings.recordingFormat === FORMAT_WAV
						? await this.mergeAudioTracks()
						: await this.combineTracksWithoutConversion();
				const fileName = `${this.settings.filePrefix}-multitrack-${timestamp}.${this.settings.recordingFormat}`;
				const filePath = await this.saveAudioFile(
					mergedAudio,
					fileName,
				);
				if (filePath) {
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
				const blob = await this.buildTrackBlob(target);
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
		return bufferToWave(renderedBuffer, renderedBuffer.length);
	}

	private async combineTracksWithoutConversion(): Promise<Blob> {
		const trackBlobs = await Promise.all(
			this.chunkTargets.map((target) => this.buildTrackBlob(target)),
		);
		const nonEmptyTrackBlobs = trackBlobs.filter(
			(blob): blob is Blob => blob !== null && blob.size > 0,
		);
		if (nonEmptyTrackBlobs.length === 0) {
			throw new Error('No audio data recorded');
		}
		this.debugLogger.log(
			'Combining multi-track data without WAV conversion',
			{
				trackCount: nonEmptyTrackBlobs.length,
				format: this.settings.recordingFormat,
			},
		);
		return new Blob(nonEmptyTrackBlobs, {
			type: `${MIME_TYPE_AUDIO_PREFIX}${this.settings.recordingFormat}`,
		});
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

			if (!target.tempFilePath) {
				return;
			}
			try {
				const newData = await data.arrayBuffer();
				const existing = await this.app.vault.adapter.readBinary(
					target.tempFilePath,
				);
				const merged = new Uint8Array(
					existing.byteLength + newData.byteLength,
				);
				merged.set(new Uint8Array(existing), 0);
				merged.set(new Uint8Array(newData), existing.byteLength);
				await this.app.vault.adapter.writeBinary(
					target.tempFilePath,
					merged.buffer,
				);
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to append chunk:`,
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
		const type = this.getRecorderMediaType();
		if (target.tempFilePath) {
			const data = await this.app.vault.adapter.readBinary(
				target.tempFilePath,
			);
			return new Blob([data], { type });
		}

		if (
			target.segmentPaths.length === 0 &&
			target.bufferedChunks.length === 0
		) {
			return null;
		}

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
		const intermediatePaths = this.chunkTargets.flatMap((target) => {
			const paths: string[] = [];
			if (target.tempFilePath) {
				paths.push(target.tempFilePath);
			}
			paths.push(...target.segmentPaths);
			return paths;
		});

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

		if (!target.tempFilePath) {
			return fileLinks;
		}

		const fileName = `${this.settings.filePrefix}-${target.sourceName}-${timestamp}.${this.settings.recordingFormat}`;
		const filePath = await this.resolveUniquePath(fileName);

		if (this.settings.recordingFormat === FORMAT_WAV) {
			const data = await this.app.vault.adapter.readBinary(
				target.tempFilePath,
			);
			const wavBlob = await this.convertBlobToWav(
				new Blob([data], {
					type: this.getRecorderMediaType(),
				}),
			);
			await this.app.vault.createBinary(
				filePath,
				await wavBlob.arrayBuffer(),
			);
			const failedCleanupPaths = await this.removeTemporaryArtifacts(
				[target.tempFilePath],
				'Failed to remove temporary track file after WAV conversion',
			);
			if (failedCleanupPaths.length > 0) {
				await this.rollbackFinalFile(
					filePath,
					'Failed to rollback finalized WAV track',
				);
				throw new Error(
					`Temporary recording artifacts were kept for recovery: ${failedCleanupPaths.join(', ')}`,
				);
			}
		} else {
			await this.app.vault.adapter.rename(target.tempFilePath, filePath);
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
		if (outputFormat === FORMAT_WAV) {
			const preferredCompressedFormats = [FORMAT_WEBM, FORMAT_OGG];
			for (const format of preferredCompressedFormats) {
				const mimeType = buildMimeType(format);
				if (MediaRecorder.isTypeSupported(mimeType)) {
					return { recorderFormat: format, mimeType: mimeType };
				}
			}
			throw new Error(
				'WAV output requires an intermediate compressed format, but neither WebM nor OGG is supported in this browser.',
			);
		}

		return {
			recorderFormat: outputFormat,
			mimeType: buildMimeType(outputFormat),
		};
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

	private insertFileLinks(fileLinks: string[]): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (editor) {
			const links = fileLinks
				.map((path) => {
					const fileName = path.split('/').pop() ?? path;
					return `![[${fileName}]]`;
				})
				.join('\n');
			editor.replaceSelection(links);
		}
	}
}
