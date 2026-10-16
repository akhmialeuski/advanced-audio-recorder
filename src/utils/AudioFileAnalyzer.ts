/**
 * Data structures and utilities for extracting audio file metadata.
 * Metadata is read through mediabunny's container probe, which parses
 * headers instead of decoding the whole file to PCM; the full decode is
 * kept only as a fallback for containers the probe cannot parse.
 * @module utils/AudioFileAnalyzer
 */

import { App, Notice, TFile } from 'obsidian';
import { BufferSource } from 'mediabunny';
import type { Input, InputAudioTrack } from 'mediabunny';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	audioMimeForExtension,
	getFormatDescriptor,
} from '../audio/formatRegistry';
import { isDecodableSize } from '../platform/capabilities';
import {
	probeBlobDurationSeconds,
	probeMediaDurationSeconds,
	usableSeconds,
} from './mediaDuration';
import { formatByteSize } from './formatBytes';
import { formatTimecode } from './TimeUtils';
import { autoClosing } from './disposables';
import { resourceSource, withMediaInput } from '../audio/mediaInput';

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
 * The info as a Markdown list, the form the dialog copies and the command
 * line prints: one bullet per field, the value in code so a path or a codec
 * name survives being pasted anywhere.
 * @param info - The info to list
 * @returns The list, one line per field
 */
export function formatAudioFileInfo(info: AudioFileInfo): string {
	return [
		`- **File Name:** \`${info.fileName}\``,
		`- **File Size:** \`${info.fileSize}\``,
		`- **Duration:** \`${info.duration}\``,
		`- **Container Format:** \`${info.containerFormat}\``,
		`- **Audio Codec:** \`${info.audioCodec}\``,
		`- **Bitrate:** \`${info.bitrate}\``,
		`- **Sample Rate:** \`${info.sampleRate}\``,
		`- **Channels:** \`${info.channels}\``,
	].join('\n');
}

/** What a reader shows in place of a number no probe could read. */
const UNKNOWN_VALUE = 'unknown';

/**
 * Packets the bitrate is measured over, at most.
 *
 * A packet walk reads only headers, but on a container without an index - the
 * WebM a recorder writes live - that is a read of the whole file through the
 * resource URL, and the dialog waits for it. Thirty thousand packets is ten
 * minutes of Opus or AAC and longer for the codecs with bigger packets, enough
 * to settle the average of a variable-bitrate stream, while a constant-bitrate
 * one is exact after its first packet.
 */
const BITRATE_SAMPLE_PACKETS = 30_000;

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
 * What a container parse says a file holds, beyond its timing: the answers the
 * file extension used to stand in for.
 */
export interface ContainerContents {
	/** The container's MIME type as the demuxer names it, without parameters. */
	mimeType: string;
	/** Codec of the primary audio track, or null where the demuxer named none. */
	codec: string | null;
	/**
	 * Bits per second of audio, from the track's own declaration or from the
	 * sizes of its packets, or null where neither could be read. Container
	 * overhead and embedded artwork are not in it, which is what tells it
	 * apart from the file size divided by the length.
	 */
	bitrate: number | null;
}

/** The metadata the info dialog shows, with what the container holds. */
interface DescribedAudioMetadata extends ProbedAudioMetadata {
	/** What the container holds, or null where nothing parsed it. */
	contents: ContainerContents | null;
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
		const { contents } = metadata;

		// The audio's own rate where the container gave one. Otherwise the
		// file size over the length, which counts the container and any
		// artwork along with the audio, and which a length nothing could read
		// leaves undefined rather than at zero.
		const bitsPerSecond =
			contents?.bitrate ??
			(durationInSeconds === null
				? null
				: (fileSizeInBytes * 8) / durationInSeconds);
		const bitrate =
			bitsPerSecond === null
				? UNKNOWN_VALUE
				: `${String(Math.round(bitsPerSecond / 1000))} kbps`;

		// The extension names the container and the codec only where no
		// parse could: a .webm may hold Vorbis, a .wav 24-bit samples, and a
		// file renamed by hand anything at all.
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
			containerFormat:
				contents?.mimeType ?? audioMimeForExtension(extension),
			audioCodec: contents
				? (contents.codec ?? UNKNOWN_VALUE)
				: (getFormatDescriptor(extension)?.codecLabel ?? UNKNOWN_VALUE),
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
 * Completes a container's answer with a length it did not carry.
 *
 * A parse that read everything but the length has not finished the job, and
 * that is what this plugin's own recordings look like: a recorder streaming
 * into a container stamps no length into the segment it has not finished. What
 * is missing is only the length, so only the length is asked for, through
 * whichever reader the caller can afford - and that is the whole difference
 * between the two callers, which is why the rule itself is written once.
 * @param probed - What the container parse did read
 * @param readDuration - Asks the browser for the length the headers lack
 * @returns The metadata, with a length where one could be read
 */
async function withReadDuration<T extends ProbedAudioMetadata>(
	probed: T,
	readDuration: () => Promise<number | null>,
): Promise<T> {
	if (probed.durationSeconds !== null) {
		return probed;
	}
	const played = await readDuration();
	return played === null ? probed : { ...probed, durationSeconds: played };
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
 * The same URL is what answers a length the headers do not carry, because a
 * media element streams it exactly as the parse did. Reading the file in to ask
 * that question would hold the whole recording in memory, and a second copy of
 * it for the blob, to learn one number the address already on hand gives for
 * nothing - on precisely the files this plugin records itself.
 *
 * The bytes are read only where the ranged probe could not parse the container
 * at all, since the sample rate and the channel count then exist nowhere but
 * the decoded buffer.
 *
 * Either parse also says what the container holds, which the dialog shows in
 * place of what the extension suggests; a file only a decode could read has
 * nothing to say about that, and the extension is all that is left.
 * @param app - Obsidian App
 * @param file - The recording to measure
 * @returns The metadata, or null when neither path could read it
 */
async function probeFileMetadata(
	app: App,
	file: TFile,
): Promise<DescribedAudioMetadata | null> {
	const { metadata } = await probeAtAddress(app, file, (input) =>
		describeInput(input, file.path),
	);
	if (metadata) {
		return metadata;
	}
	const bytes = await app.vault.readBinary(file);
	return await readBytes(
		bytes,
		file.path,
		(input) => describeInput(input, file.path),
		(decoded) => ({ ...decoded, contents: null }),
	);
}

/**
 * The cheap half of {@link probeFileMetadata}: the container headers over
 * ranged reads, completed with a length from the media element at the same
 * address when the headers lack one. Shared with {@link probeDurationSeconds}
 * so the two cannot disagree on what a recording's length is.
 * @param app - Obsidian App
 * @param file - The recording to measure
 * @param read - Reads the metadata from the opened container
 * @returns The resource address, and the metadata or null when the
 *   container could not be parsed
 */
async function probeAtAddress<T extends ProbedAudioMetadata>(
	app: App,
	file: TFile,
	read: (input: Input) => Promise<T | null>,
): Promise<{ url: string; metadata: T | null }> {
	const url = app.vault.getResourcePath(file);
	const ranged = await withMediaInput(resourceSource(url), read);
	return {
		url,
		metadata: ranged
			? await withReadDuration(ranged, () =>
					probeMediaDurationSeconds(url),
				)
			: null,
	};
}

/**
 * A recording's length, read only through the cheap readers: the container
 * headers over ranged reads, then the browser's own media pipeline at the
 * same address. Never the bytes: a caller that merely displays a length - the
 * recording panel, which reads it because a note was opened - must not hold a
 * multi-hour file in memory, or decode it, for a number nobody asked for.
 * @param app - Obsidian App
 * @param file - The recording to measure
 * @returns The length in seconds, or null when neither reader could give one
 */
export async function probeDurationSeconds(
	app: App,
	file: TFile,
): Promise<number | null> {
	const { url, metadata } = await probeAtAddress(app, file, (input) =>
		readTrackMetadata(input, file.path),
	);
	// A container the probe cannot parse can still be played, and playing
	// its metadata is what reads a length without the bytes.
	return metadata
		? metadata.durationSeconds
		: await probeMediaDurationSeconds(url);
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
 * The full decode is what remains when the container did not parse at all, and
 * only then: the sample rate and the channel count exist nowhere but the decoded
 * buffer for such a file, so it is the one reader left that has them, and it is
 * bounded by the platform's decode ceiling because it expands the whole
 * recording to PCM. A container that did parse has already given both, so the
 * only thing a decode could add there is the length the browser has just
 * declined to read - on the same demuxer, since a media element and
 * `decodeAudioData` are the same engine. Paying gigabytes of samples to ask that
 * question again is how the cheapest read in the plugin became its most
 * expensive one, so the length simply stays unread instead.
 *
 * A caller that only wants the cheap header answer, to reject an oversized file
 * before decoding it, still calls {@link probeAudioMetadata}.
 *
 * The bytes are read, never taken: a caller holding a file it is about to do
 * something else with - the transcribe dialog reads it once and hands the same
 * bytes to the run - gets them back intact.
 * @param data - The file's bytes, which this leaves usable
 * @param path - Vault path, for the warning log and the container's MIME type
 * @returns The metadata, or null when no reader could read it
 */
export async function readAudioMetadata(
	data: ArrayBuffer,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	return await readBytes(
		data,
		path,
		(input) => readTrackMetadata(input, path),
		(decoded) => decoded,
	);
}

/**
 * The read order of {@link readAudioMetadata}, for whichever parse a caller
 * asks for: the info dialog wants what the container holds as well, and a
 * caller sizing a decode wants only the numbers.
 * @param data - The file's bytes, which this leaves usable
 * @param path - Vault path, for the warning log and the container's MIME type
 * @param parse - Reads the opened container
 * @param fromDecode - Shapes what a decode read into what the parse returns
 * @returns The metadata, or null when no reader could read it
 */
async function readBytes<T extends ProbedAudioMetadata>(
	data: ArrayBuffer,
	path: string,
	parse: (input: Input) => Promise<T | null>,
	fromDecode: (decoded: ProbedAudioMetadata) => T,
): Promise<T | null> {
	const probed = await withMediaInput(new BufferSource(data), parse);
	if (probed) {
		return await withReadDuration(probed, () =>
			probeBlobDurationSeconds(
				data,
				audioMimeForExtension(extensionOf(path)),
			),
		);
	}
	if (!isDecodableSize(data.byteLength)) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} ${path} is too large to decode on this device; its metadata stays unread.`,
		);
		return null;
	}
	const decoded = await decodeMetadata(data);
	return decoded && fromDecode(decoded);
}

/**
 * The lowercase extension of a vault path, which is what names the container.
 * @param path - Vault path of the recording
 */
function extensionOf(path: string): string {
	return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
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
	return await withMediaInput(new BufferSource(data), (input) =>
		readTrackMetadata(input, path),
	);
}

/**
 * The primary audio track's numbers from an opened input.
 * @param input - An opened mediabunny input
 * @param path - Vault path, for the warning log only
 * @returns The metadata, or null when there is no audio track or the parse failed
 */
async function readTrackMetadata(
	input: Input,
	path: string,
): Promise<ProbedAudioMetadata | null> {
	return (await openPrimaryTrack(input, path))?.metadata ?? null;
}

/**
 * The primary audio track's numbers and what the container holds, for the
 * info dialog.
 * @param input - An opened mediabunny input
 * @param path - Vault path, for the warning log only
 * @returns The description, or null when there is no audio track or the parse failed
 */
async function describeInput(
	input: Input,
	path: string,
): Promise<DescribedAudioMetadata | null> {
	const opened = await openPrimaryTrack(input, path);
	if (!opened) {
		return null;
	}
	return {
		...opened.metadata,
		contents: await readContents(input, opened.track, path),
	};
}

/**
 * What the container holds, read rather than guessed from the extension.
 *
 * Best effort: the numbers the dialog exists for have already been read, so a
 * failure here costs only the description, which the extension then supplies
 * as it always did.
 * @param input - An opened mediabunny input
 * @param track - Its primary audio track
 * @param path - Vault path, for the warning log only
 * @returns The contents, or null when they could not be read
 */
async function readContents(
	input: Input,
	track: InputAudioTrack,
	path: string,
): Promise<ContainerContents | null> {
	try {
		// The full type carries the codec parameters as well, which the
		// codec row already shows on its own.
		const [mimeType = ''] = (await input.getMimeType()).split(';');
		return {
			mimeType: mimeType.trim(),
			codec: await track.getCodec(),
			bitrate: await measureBitrate(track),
		};
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Could not read what ${path} holds; describing it by its extension:`,
			error,
		);
		return null;
	}
}

/**
 * The audio's own bitrate: the one the track declares, where it declares a
 * usable one, and otherwise the sizes of its packets over their duration, read
 * from the packet headers alone.
 *
 * MP4 is the container that declares one; the others leave the question to
 * the packets, which is also the only honest answer for a variable-bitrate
 * stream.
 * @param track - The primary audio track
 * @returns Bits per second, or null when neither source gave a usable figure
 */
async function measureBitrate(track: InputAudioTrack): Promise<number | null> {
	const declared = await track.getAverageBitrate();
	if (declared !== null && isUsableRate(declared)) {
		return declared;
	}
	const { averageBitrate } = await track.computePacketStats(
		BITRATE_SAMPLE_PACKETS,
	);
	return isUsableRate(averageBitrate) ? averageBitrate : null;
}

/**
 * Whether a bitrate is a measurement rather than its absence: zero is what an
 * empty walk and an unset field both read as, and a stream of zero-length
 * packets divides to infinity.
 * @param bitsPerSecond - The figure to judge
 */
function isUsableRate(bitsPerSecond: number): boolean {
	return bitsPerSecond > 0 && Number.isFinite(bitsPerSecond);
}

/**
 * Pulls the primary audio track's numbers out of an opened input, with the
 * track itself for a caller that reads more. Shared by the buffered and ranged
 * probes, which differ only in where their bytes come from - so a container
 * the one can read, the other can too.
 *
 * Every caller runs inside withMediaInput, which awaits the read before the
 * input is disposed; see there for what an unawaited read costs.
 * @param input - An opened mediabunny input
 * @param path - Vault path, for the warning log only
 * @returns The numbers and the track, or null when there is no audio track or
 *   the parse failed
 */
async function openPrimaryTrack(
	input: Input,
	path: string,
): Promise<{ metadata: ProbedAudioMetadata; track: InputAudioTrack } | null> {
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			return null;
		}
		const duration = await input.computeDuration();
		return {
			metadata: {
				// A stream whose last packet the parse never reached comes
				// back as zero, which is not a length: the shared rule turns
				// it into "unread" rather than leaving each reader to
				// recognise it.
				durationSeconds: usableSeconds(duration),
				sampleRate: await track.getSampleRate(),
				channels: await track.getNumberOfChannels(),
			},
			track,
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
 * @param data - The file's bytes, which are read and not taken
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
		// Decoded from a copy, because decodeAudioData does not read its input,
		// it takes it: the buffer comes back detached and empty. Callers here
		// hand over bytes they still hold - the transcribe dialog reads the
		// file once and passes the same bytes to the run - so taking them left
		// the run uploading nothing, and the engine answering that the audio is
		// corrupt. The copy costs one more encoded file in memory next to the
		// PCM this call is about to materialize anyway.
		const audioBuffer = await audioContext.decodeAudioData(data.slice(0));
		return {
			// Zero means the same thing here as everywhere else: nothing was
			// read, not "no time passed".
			durationSeconds: usableSeconds(audioBuffer.duration),
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
