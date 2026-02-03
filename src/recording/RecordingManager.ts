/**
 * Recording manager for handling audio recording lifecycle.
 * @module recording/RecordingManager
 */

import { MarkdownView, normalizePath, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	getAudioStreams,
	getAudioSourceName,
	stopAllStreams,
} from './AudioStreamHandler';
import { bufferToWave } from './WavEncoder';

/**
 * Manages the audio recording lifecycle.
 */
export class RecordingManager {
	private recorders: MediaRecorder[] = [];
	private audioChunks: Blob[][] = [];
	private streams: MediaStream[] = [];
	private status: RecordingStatus = RecordingStatus.Idle;
	private onStatusChange: (status: RecordingStatus) => void;

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
			const mimeType = `audio/${this.settings.recordingFormat};codecs=opus`;
			if (!MediaRecorder.isTypeSupported(mimeType)) {
				throw new Error(
					`The format ${this.settings.recordingFormat} is not supported in this browser.`,
				);
			}

			this.streams = await getAudioStreams(this.settings);
			this.recorders = this.streams.map(
				(stream) => new MediaRecorder(stream, { mimeType }),
			);
			this.audioChunks = this.recorders.map(() => []);

			this.recorders.forEach((recorder, index) => {
				recorder.ondataavailable = (event: BlobEvent): void => {
					if (event.data.size > 0) {
						this.audioChunks[index].push(event.data);
					}
				};
				recorder.onerror = (event: Event): void => {
					console.error('[AudioRecorder] Recorder error:', event);
				};
				recorder.start();
			});

			this.setStatus(RecordingStatus.Recording);
			new Notice('Recording started');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Error starting recording: ${message}`);
			console.error('[AudioRecorder] Error in startRecording:', error);
		}
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

			await this.saveRecording();
			new Notice('Recording stopped');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Error stopping recording: ${message}`);
			console.error('[AudioRecorder] Error in stopRecording:', error);
		} finally {
			stopAllStreams(streamsToStop);
			this.streams = [];
			this.recorders = [];
			this.audioChunks = [];
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
		this.audioChunks = [];
		this.streams = [];
	}

	private setStatus(status: RecordingStatus): void {
		this.status = status;
		this.onStatusChange(status);
	}

	private async saveRecording(): Promise<void> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const fileLinks: string[] = [];

		if (this.settings.outputMode === 'single') {
			const mergedAudio = await this.mergeAudioTracks();
			const fileName = `${this.settings.filePrefix}-multitrack-${timestamp}.wav`;
			const filePath = await this.saveAudioFile(mergedAudio, fileName);
			if (filePath) {
				fileLinks.push(filePath);
			}
		} else {
			for (let i = 0; i < this.audioChunks.length; i++) {
				const chunks = this.audioChunks[i];
				if (chunks.length === 0) {
					continue;
				}

				const audioBlob = new Blob(chunks, {
					type: `audio/${this.settings.recordingFormat}`,
				});
				const trackNumber = i + 1;
				const deviceId = this.settings.trackAudioSources[trackNumber];
				const sourceName = deviceId
					? await getAudioSourceName(deviceId)
					: `Track${trackNumber}`;
				const fileName = `${this.settings.filePrefix}-${sourceName}-${timestamp}.${this.settings.recordingFormat}`;
				const filePath = await this.saveAudioFile(audioBlob, fileName);
				if (filePath) {
					fileLinks.push(filePath);
				}
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
			this.audioChunks.map(async (chunks) => {
				if (chunks.length === 0) {
					return null;
				}
				const blob = new Blob(chunks, {
					type: `audio/${this.settings.recordingFormat}`,
				});
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

	private async saveAudioFile(
		audioBlob: Blob,
		fileName: string,
	): Promise<string | null> {
		if (audioBlob.size === 0) {
			console.debug(`[AudioRecorder] Skipping empty file: ${fileName}`);
			return null;
		}

		const arrayBuffer = await audioBlob.arrayBuffer();
		let sanitizedFileName = fileName.replace(/[\\/:*?"<>|]/g, '-');
		let filePath = normalizePath(
			`${this.settings.saveFolder}/${sanitizedFileName}`,
		);

		let counter = 1;
		while (await this.app.vault.adapter.exists(filePath)) {
			const parts = sanitizedFileName.split('.');
			const ext = parts.pop() ?? '';
			const name = parts.join('.');
			sanitizedFileName = `${name}_${String(counter)}.${ext}`;
			filePath = normalizePath(
				`${this.settings.saveFolder}/${sanitizedFileName}`,
			);
			counter++;
		}

		await this.app.vault.createBinary(filePath, arrayBuffer);
		return filePath;
	}

	private insertFileLinks(fileLinks: string[]): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (editor) {
			const links = fileLinks.map((path) => `![[${path}]]`).join('\n');
			editor.replaceSelection(links);
		}
	}
}
