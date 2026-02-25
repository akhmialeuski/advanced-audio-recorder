/**
 * Data structures and utilities for extracting audio file metadata.
 * @module utils/AudioFileAnalyzer
 */

import { App, Notice, TFile } from 'obsidian';

/**
 * Represents detailed information about an audio file.
 */
export interface AudioFileInfo {
	fileName: string;
	fileSize: string;
	duration: string;
	containerFormat: string;
	audioCodec: string;
	bitrate: string;
	sampleRate: string;
	channels: string;
}

/**
 * Extracts metadata from an audio file.
 * @param app - The Obsidian App instance.
 * @param file - The audio file to analyze.
 * @returns A promise that resolves to the audio file information, or null if it fails.
 */
export async function getAudioFileInfo(
	app: App,
	file: TFile,
): Promise<AudioFileInfo | null> {
	try {
		const arrayBuffer = await app.vault.readBinary(file);

		// Attempt to decode the audio data using the browser's native AudioContext.
		// Use window.AudioContext or window.webkitAudioContext for cross-browser compatibility.
		const AudioContextClass =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AudioContextClass) {
			console.error(
				'[AudioRecorder] AudioContext is not supported in this environment.',
			);
			new Notice(
				'AudioContext is not supported. Cannot extract audio metadata.',
			);
			return null;
		}

		const audioContext = new AudioContextClass();
		let audioBuffer: AudioBuffer;

		try {
			audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		} catch (e) {
			console.error('[AudioRecorder] Failed to decode audio data:', e);
			new Notice('Failed to decode audio file data.');
			return null;
		} finally {
			// Ensure we release the context resources after decoding
			if (audioContext.state !== 'closed') {
				await audioContext.close();
			}
		}

		const fileSizeInBytes = file.stat.size;
		const durationInSeconds = audioBuffer.duration;

		// Calculate bitrate in kbps
		// bitRate = (fileSizeInBytes * 8 bits) / durationInSeconds
		let bitrateKbps = 0;
		if (durationInSeconds > 0) {
			bitrateKbps = Math.round(
				(fileSizeInBytes * 8) / durationInSeconds / 1000,
			);
		}

		const extension = file.extension.toLowerCase();

		return {
			fileName: file.name,
			fileSize: formatBytes(fileSizeInBytes),
			duration: formatDuration(durationInSeconds),
			containerFormat: getMimeTypeFromExtension(extension),
			audioCodec: inferCodecFromExtension(extension),
			bitrate: `${bitrateKbps} kbps`,
			sampleRate: `${audioBuffer.sampleRate} Hz`,
			channels: formatChannels(audioBuffer.numberOfChannels),
		};
	} catch (error) {
		console.error('[AudioRecorder] Error analyzing audio file:', error);
		new Notice('An error occurred while analyzing the audio file.');
		return null;
	}
}

/**
 * Formats a byte size into a human-readable string.
 * @param bytes - The size in bytes.
 * @param decimals - Number of decimal places.
 * @returns Formatted size string.
 */
function formatBytes(bytes: number, decimals = 2): string {
	if (!+bytes) return '0 Bytes';

	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Formats duration in seconds to HH:MM:SS string.
 * @param seconds - Total seconds.
 * @returns Formatted duration string.
 */
function formatDuration(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) {
		return '00:00:00';
	}

	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);

	const pad = (num: number) => num.toString().padStart(2, '0');

	if (h > 0) {
		return `${pad(h)}:${pad(m)}:${pad(s)}`;
	}
	return `00:${pad(m)}:${pad(s)}`;
}

/**
 * Formats the number of channels into a readable string.
 * @param channels - Number of audio channels.
 * @returns Formatted channels string.
 */
function formatChannels(channels: number): string {
	if (channels === 1) return '1 (Mono)';
	if (channels === 2) return '2 (Stereo)';
	return `${channels} channels`;
}

/**
 * Infers the likely audio codec based on the file extension.
 * @param extension - The file extension.
 * @returns The inferred codec string.
 */
function inferCodecFromExtension(extension: string): string {
	switch (extension) {
		case 'webm':
			return 'opus';
		case 'ogg':
			return 'opus/vorbis';
		case 'mp4':
		case 'm4a':
		case 'aac':
			return 'aac';
		case 'mp3':
			return 'mp3';
		case 'wav':
			return 'pcm';
		case 'flac':
			return 'flac';
		default:
			return 'unknown';
	}
}

/**
 * Gets the standard MIME type for the audio container format.
 * @param extension - The file extension.
 * @returns The MIME type string.
 */
function getMimeTypeFromExtension(extension: string): string {
	switch (extension) {
		case 'webm':
			return 'audio/webm';
		case 'ogg':
			return 'audio/ogg';
		case 'mp4':
		case 'm4a':
			return 'audio/mp4';
		case 'aac':
			return 'audio/aac';
		case 'mp3':
			return 'audio/mpeg';
		case 'wav':
			return 'audio/wav';
		case 'flac':
			return 'audio/flac';
		default:
			return `audio/${extension}`;
	}
}
