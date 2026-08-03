/**
 * Data structures and utilities for extracting audio file metadata.
 * Metadata is read through mediabunny's container probe, which parses
 * headers instead of decoding the whole file to PCM; the full decode is
 * kept only as a fallback for containers the probe cannot parse.
 * @module utils/AudioFileAnalyzer
 */

import { App, Notice, TFile } from 'obsidian';
import { ALL_FORMATS, BufferSource, Input, UrlSource } from 'mediabunny';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	audioMimeForExtension,
	getFormatDescriptor,
} from '../audio/formatRegistry';
import { isDecodableSize } from '../platform/capabilities';
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
export interface ProbedAudioMetadata {
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
		const metadata = await probeFileMetadata(app, file);
		if (!metadata) {
			// Neither the headers nor a decode could read the file, which is
			// what this action was opened to show; the reason is in the log.
			new Notice('Could not read this audio file to show its details.');
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
 * Reads a recording's metadata without loading the whole file.
 *
 * The container probe only needs the header and the index, which for a
 * multi-hour recording is a tiny fraction of the bytes - but the Obsidian
 * vault adapter exposes no ranged read, so reading through it means holding
 * the entire file in memory to look at its first few kilobytes. The resource
 * URL does serve ranges (it is what the audio element seeks against), so the
 * probe reads through that and mediabunny fetches only the ranges it needs.
 *
 * Falls back to the whole-file read when the ranged probe cannot parse the
 * file - an environment that does not honor the range request, or a container
 * mediabunny does not know, which then needs the full decode anyway.
 * @param app - Obsidian App
 * @param file - The recording to measure
 * @returns The metadata, or null when neither path could read it
 */
async function probeFileMetadata(
	app: App,
	file: TFile,
): Promise<ProbedAudioMetadata | null> {
	const ranged = await probeAudioMetadataAt(
		app.vault.getResourcePath(file),
		file.path,
	);
	if (ranged) {
		return ranged;
	}
	const bytes = await app.vault.readBinary(file);
	return readAudioMetadata(bytes, file.path);
}

/**
 * A recording's metadata from its bytes, whichever path can read it: the
 * container probe first, and the full decode when the headers do not answer.
 *
 * The two paths belong together because a caller that needs the duration needs
 * it either way, and the header alone is the answer that fails on this plugin's
 * own output: a recorder writing live leaves no duration in the segment it has
 * not finished, so a caller that only probed got nothing for exactly the files
 * the plugin produces. A caller that only wants the cheap answer, to reject an
 * oversized file before decoding it, still calls {@link probeAudioMetadata}.
 *
 * The fallback is bounded by the platform's decode ceiling, like every other
 * path that expands a file to PCM. The recordings whose headers carry no
 * duration are the long ones, so without the bound the cheapest read in the
 * plugin would become the one that decodes multi-hour audio on the main thread.
 * @param data - The file's bytes
 * @param path - Vault path, for the warning log only
 * @returns The metadata, or null when neither path could read it
 */
export async function readAudioMetadata(
	data: ArrayBuffer,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	const probed = await probeAudioMetadata(data, path);
	if (probed && probed.durationSeconds > 0) {
		return probed;
	}
	if (!isDecodableSize(data.byteLength)) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} ${path} is too large to decode on this device; its duration stays unread.`,
		);
		return probed;
	}
	// A probe answering zero for a recording that has a length has not
	// answered; the sample rate and channels it did read are kept when the
	// decode cannot improve on them either.
	return (await decodeMetadata(data)) ?? probed;
}

/**
 * Reads duration, sample rate, and channel count from the container headers at
 * a URL, fetching only the byte ranges the parse needs.
 * @param url - Resource URL of the audio file
 * @param path - Vault path, for the warning log only
 * @returns The metadata, or null when the container could not be parsed
 */
async function probeAudioMetadataAt(
	url: string,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	using input = disposableOf(
		new Input({ source: new UrlSource(url), formats: ALL_FORMATS }),
	);
	return readTrackMetadata(input, path);
}

/**
 * Reads duration, sample rate, and channel count from the container
 * headers via mediabunny - no PCM decode, so the cost stays flat no
 * matter how long the recording is. Returns null when the container
 * cannot be parsed, letting the caller fall back to a full decode.
 * @param data - The file's bytes
 * @param path - Vault path, for the warning log only
 */
export async function probeAudioMetadata(
	data: ArrayBuffer,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	using input = disposableOf(
		new Input({
			source: new BufferSource(data),
			formats: ALL_FORMATS,
		}),
	);
	return readTrackMetadata(input, path);
}

/**
 * Pulls the primary audio track's numbers out of an opened input. Shared by
 * the buffered and ranged probes, which differ only in where their bytes come
 * from - so a container the one can read, the other can too.
 * @param input - An opened mediabunny input
 * @param path - Vault path, for the warning log only
 * @returns The metadata, or null when there is no audio track or the parse failed
 */
async function readTrackMetadata(
	input: Input,
	path: string,
): Promise<ProbedAudioMetadata | null> {
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
 *
 * Reports failure by returning null and logging why. It is reached from a
 * background probe as well as from the file-info action, so what an unreadable
 * file should say is the caller's to decide rather than a Notice from here.
 * @param data - The file's bytes
 */
async function decodeMetadata(
	data: ArrayBuffer,
): Promise<ProbedAudioMetadata | null> {
	// Use window.AudioContext or window.webkitAudioContext for
	// cross-browser compatibility.
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} AudioContext is not supported in this environment.`,
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
		console.warn(`${PLUGIN_LOG_PREFIX} Failed to decode audio data:`, e);
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
