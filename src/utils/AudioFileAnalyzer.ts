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
import { probeBlobDurationSeconds } from './mediaDuration';
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

/** What a reader shows in place of a number no probe could read. */
const UNKNOWN_VALUE = 'unknown';

/** The raw numbers the info dialog is built from. */
export interface ProbedAudioMetadata {
	/**
	 * Length in seconds, or null where no reader could give one.
	 *
	 * Null rather than zero, because the two are different answers and a
	 * caller that cannot tell them apart gets the wrong one: a recording whose
	 * length is unknown is not a recording that costs nothing to transcribe,
	 * and it is not one that fits under every ceiling either. Saying so in the
	 * type is what makes every reader decide, instead of the ones that
	 * remember to compare against zero.
	 */
	durationSeconds: number | null;
	sampleRate: number;
	channels: number;
}

/**
 * Whether a probed length is known to exceed a ceiling.
 *
 * Every caller bounded by a duration asks this, and they all have to answer
 * "unknown" the same way: not as short. A length that was never read is not a
 * length under the limit, so the guard declines to reject and leaves the
 * decision to whatever checks the allocation it is about to make.
 * @param durationSeconds - The probed length, or null when it was not read
 * @param limitSeconds - The ceiling being tested against
 */
export function isKnownLongerThan(
	durationSeconds: number | null,
	limitSeconds: number,
): boolean {
	return durationSeconds !== null && durationSeconds > limitSeconds;
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

		// bitRate = (fileSizeInBytes * 8 bits) / durationInSeconds, which a
		// length nothing could read leaves undefined rather than at zero.
		const bitrate =
			durationInSeconds === null
				? UNKNOWN_VALUE
				: `${String(
						Math.round(
							(fileSizeInBytes * 8) / durationInSeconds / 1000,
						),
					)} kbps`;

		const extension = file.extension.toLowerCase();

		return {
			fileName: file.name,
			fileSize: formatByteSize(fileSizeInBytes, {
				decimals: 2,
				trimZeros: true,
				bytesLabel: 'Bytes',
			}),
			duration:
				durationInSeconds === null
					? UNKNOWN_VALUE
					: formatTimecode(durationInSeconds),
			containerFormat: audioMimeForExtension(extension),
			audioCodec:
				getFormatDescriptor(extension)?.codecLabel ?? UNKNOWN_VALUE,
			bitrate,
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
	if (ranged && ranged.durationSeconds !== null) {
		return ranged;
	}
	// A parse that read everything but the length has not finished the job,
	// which is what this plugin's own recordings look like: the paths below
	// answer where the headers do not, so reaching them cannot depend on the
	// container having failed outright.
	const bytes = await app.vault.readBinary(file);
	return (await readAudioMetadata(bytes, file.path)) ?? ranged;
}

/**
 * A recording's metadata from its bytes, through whichever reader can answer.
 *
 * The container headers come first and settle most files for nothing. They do
 * not settle this plugin's own output: a recorder streaming into a container
 * stamps no length into the segment it has not finished, so a caller that only
 * probed got nothing for exactly the files the plugin produces. What answers
 * there is the browser, which reads the same packets the probe walked and costs
 * no samples - see {@link module:utils/mediaDuration}.
 *
 * The full decode is last and is now genuinely last: it is what remains when
 * the container did not parse at all, since the sample rate and the channel
 * count have to come from somewhere and expanding the file to PCM is the only
 * reader left that has them. Bounded by the platform's decode ceiling for that
 * reason. A caller that only wants the cheap header answer, to reject an
 * oversized file before decoding it, still calls {@link probeAudioMetadata}.
 * @param data - The file's bytes
 * @param path - Vault path, for the warning log and the container's MIME type
 * @returns The metadata, or null when no reader could read it
 */
export async function readAudioMetadata(
	data: ArrayBuffer,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	const probed = await probeAudioMetadata(data, path);
	if (probed && probed.durationSeconds !== null) {
		return probed;
	}
	if (probed) {
		// The headers gave everything but the length, so only the length is
		// missing and only the length is asked for.
		const played = await probeBlobDurationSeconds(
			data,
			audioMimeForExtension(extensionOf(path)),
		);
		if (played !== null) {
			return { ...probed, durationSeconds: played };
		}
	}
	if (!isDecodableSize(data.byteLength)) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} ${path} is too large to decode on this device; its duration stays unread.`,
		);
		return probed;
	}
	// Whatever the headers did read is kept when the decode cannot improve on
	// it either, so a failed decode never costs a sample rate that was known.
	return (await decodeMetadata(data)) ?? probed;
}

/**
 * The lowercase extension of a vault path, which is what names the container.
 * @param path - Vault path of the recording
 */
function extensionOf(path: string): string {
	return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
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
		const duration = await input.computeDuration();
		return {
			// The one place a container's answer becomes this module's: a
			// stream whose last packet the parse never reached comes back as
			// zero, which is not a length, so it is turned into "unread" here
			// rather than left for each reader to recognise.
			durationSeconds: duration > 0 ? duration : null,
			sampleRate: await track.getSampleRate(),
			channels: await track.getNumberOfChannels(),
		};
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Container probe failed for ${path}; falling back to the readers that do not parse it:`,
			error,
		);
		return null;
	}
}

/**
 * Last-resort metadata path: fully decodes the file through the Web Audio API.
 *
 * It expands the whole recording to PCM, so it runs only where nothing cheaper
 * can answer at all - a container mediabunny could not parse, whose sample rate
 * and channel count exist nowhere but the decoded buffer. A file whose headers
 * merely lack a length never reaches here; the media read answers that.
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
			// Zero means the same thing here as everywhere else in this
			// module: nothing was read, not "no time passed".
			durationSeconds:
				audioBuffer.duration > 0 ? audioBuffer.duration : null,
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
