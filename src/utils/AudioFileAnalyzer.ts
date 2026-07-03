/**
 * Data structures and utilities for extracting audio file metadata.
 * @module utils/AudioFileAnalyzer
 */

import { App, Notice, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	audioMimeForExtension,
	getFormatDescriptor,
} from '../audio/formatRegistry';
import { formatByteSize } from './formatBytes';
import { formatTimecode } from './TimeUtils';

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
				`${PLUGIN_LOG_PREFIX} AudioContext is not supported in this environment.`,
			);
			new Notice(
				'Audio context is not supported. Cannot extract audio metadata.',
			);
			return null;
		}

		const audioContext = new AudioContextClass();
		let audioBuffer: AudioBuffer;

		try {
			audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		} catch (e) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to decode audio data:`,
				e,
			);
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
			fileSize: formatByteSize(fileSizeInBytes, {
				decimals: 2,
				trimZeros: true,
				bytesLabel: 'Bytes',
			}),
			duration: formatTimecode(durationInSeconds),
			containerFormat: audioMimeForExtension(extension),
			audioCodec: getFormatDescriptor(extension)?.codecLabel ?? 'unknown',
			bitrate: `${bitrateKbps} kbps`,
			sampleRate: `${audioBuffer.sampleRate} Hz`,
			channels: formatChannels(audioBuffer.numberOfChannels),
		};
	} catch (error) {
		console.error(
			`${PLUGIN_LOG_PREFIX} Error analyzing audio file:`,
			error,
		);
		new Notice('An error occurred while analyzing the audio file.');
		return null;
	}
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
