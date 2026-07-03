/**
 * Data structures and utilities for extracting audio file metadata.
 * Metadata is read through mediabunny's container probe, which parses
 * headers instead of decoding the whole file to PCM; the full decode is
 * kept only as a fallback for containers the probe cannot parse.
 * @module utils/AudioFileAnalyzer
 */

import { App, Notice, TFile } from 'obsidian';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	audioMimeForExtension,
	getFormatDescriptor,
} from '../audio/formatRegistry';
import { formatByteSize } from './formatBytes';
import { formatTimecode } from './TimeUtils';
import { autoClosing, disposableOf } from './disposables';

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

/** The raw numbers the info dialog is built from. */
interface ProbedAudioMetadata {
	durationSeconds: number;
	sampleRate: number;
	channels: number;
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

		const metadata =
			(await probeMetadata(arrayBuffer, file.path)) ??
			(await decodeMetadata(arrayBuffer));
		if (!metadata) {
			return null;
		}

		const fileSizeInBytes = file.stat.size;
		const durationInSeconds = metadata.durationSeconds;

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
			sampleRate: `${metadata.sampleRate} Hz`,
			channels: formatChannels(metadata.channels),
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
 * Reads duration, sample rate, and channel count from the container
 * headers via mediabunny - no PCM decode, so the cost stays flat no
 * matter how long the recording is. Returns null when the container
 * cannot be parsed, letting the caller fall back to a full decode.
 * @param data - The file's bytes
 * @param path - Vault path, for the warning log only
 */
async function probeMetadata(
	data: ArrayBuffer,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	using input = disposableOf(
		new Input({
			source: new BufferSource(data),
			formats: ALL_FORMATS,
		}),
	);
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			return null;
		}
		return {
			durationSeconds: await input.computeDuration(),
			sampleRate: await track.getSampleRate(),
			channels: await track.getNumberOfChannels(),
		};
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Container probe failed for ${path}; falling back to a full decode:`,
			error,
		);
		return null;
	}
}

/**
 * Fallback metadata path: fully decodes the file through the Web Audio
 * API. Expensive for long recordings, so it only runs when the container
 * probe could not parse the file.
 * @param data - The file's bytes
 */
async function decodeMetadata(
	data: ArrayBuffer,
): Promise<ProbedAudioMetadata | null> {
	// Use window.AudioContext or window.webkitAudioContext for
	// cross-browser compatibility.
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) {
		console.error(
			`${PLUGIN_LOG_PREFIX} AudioContext is not supported in this environment.`,
		);
		new Notice(
			'Audio context is not supported. Cannot extract audio metadata.',
		);
		return null;
	}

	// The context is released after decoding - autoClosing skips a
	// context that is already closed
	await using audioContext = autoClosing(new AudioContextClass());
	try {
		const audioBuffer = await audioContext.decodeAudioData(data);
		return {
			durationSeconds: audioBuffer.duration,
			sampleRate: audioBuffer.sampleRate,
			channels: audioBuffer.numberOfChannels,
		};
	} catch (e) {
		console.error(`${PLUGIN_LOG_PREFIX} Failed to decode audio data:`, e);
		new Notice('Failed to decode audio file data.');
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
