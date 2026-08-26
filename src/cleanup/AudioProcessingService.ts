/**
 * On-demand audio cleanup: decode an existing audio file, apply the
 * selected DSP stages (noise gate, high-pass filter, loudness leveling)
 * offline, and write a processed WAV copy next to the source. Invoked
 * from the context menu - it never runs during live recording.
 * @module cleanup/AudioProcessingService
 */

import type { App, TFile } from 'obsidian';
import { CLEANUP_SEGMENT_SECONDS, CLEANUP_WARMUP_SECONDS } from '../constants';
import {
	getMaxCleanupDecodedSamples,
	getMaxCleanupSeconds,
	isDecodableSize,
	tooLargeMessage,
} from '../platform/capabilities';
import {
	isKnownLongerThan,
	probeAudioMetadata,
} from '../utils/AudioFileAnalyzer';
import { createWavFileBuffer, WAV_HEADER_SIZE } from '../audio/WavEncoder';
import { floatToInt16 } from '../audio/pcm';
import { downmixChannelData, isMonoChannelMode } from '../audio/downmix';
import { directoryOf } from '../utils/paths';
import { resolveUniquePathInDirectory } from '../audio/RecordingFileManager';
import { delay } from '../utils/TimeUtils';
import {
	applyNoiseGateToChannel,
	dbToGain,
	type AudioDspConfig,
} from './audioDsp';

/**
 * Writes `frameCount` interleaved 16-bit PCM frames from `channels`, starting
 * at source frame `srcFrom`, into the WAV PCM region at destination frame
 * `destFrame`. Used to fill the output one processed segment at a time.
 * @param pcm - DataView over the WAV PCM region (after the header)
 * @param channels - Per-channel segment samples
 * @param srcFrom - First source frame to copy (skips the discarded warm-up)
 * @param frameCount - Number of frames to write
 * @param destFrame - Destination frame offset within the output
 */
function writeWavSegment(
	pcm: DataView,
	channels: Float32Array[],
	srcFrom: number,
	frameCount: number,
	destFrame: number,
): void {
	const numChannels = channels.length;
	let offset = destFrame * numChannels * 2;
	for (let frame = 0; frame < frameCount; frame++) {
		for (let channel = 0; channel < numChannels; channel++) {
			pcm.setInt16(
				offset,
				floatToInt16(channels[channel]?.[srcFrom + frame] ?? 0),
				true,
			);
			offset += 2;
		}
	}
}

/** Loudness-leveling compressor curve, fixed and tuned for speech. */
const LEVELING_COMPRESSOR_THRESHOLD_DB = -24;
const LEVELING_COMPRESSOR_KNEE_DB = 30;
const LEVELING_COMPRESSOR_RATIO = 12;
const LEVELING_COMPRESSOR_ATTACK_S = 0.003;
const LEVELING_COMPRESSOR_RELEASE_S = 0.25;

/**
 * Runs the offline audio-cleanup pipeline.
 */
export class AudioProcessingService {
	/**
	 * @param app - Obsidian app handle
	 * @param segmentSeconds - Processing segment length; defaults to
	 *   {@link CLEANUP_SEGMENT_SECONDS}. Overridable so tests can force
	 *   multi-segment behavior on a short clip.
	 */
	constructor(
		private readonly app: App,
		private readonly segmentSeconds: number = CLEANUP_SEGMENT_SECONDS,
	) {}

	/**
	 * Processes an audio file and writes a cleaned WAV copy. The signal is
	 * decoded once, then gated and rendered one time segment at a time directly
	 * into the output buffer, so peak memory is bounded by the decoded input
	 * and the WAV output rather than growing with the recording length - a long
	 * recording is cleaned up in memory without the old "split first" detour.
	 * @param file - Source audio file
	 * @param config - Stages to apply
	 * @returns Vault path of the written file
	 */
	async process(file: TFile, config: AudioDspConfig): Promise<string> {
		// Platform-dependent ceiling: mobile WebViews get a far smaller
		// memory budget than the desktop renderer.
		if (!isDecodableSize(file.stat.size)) {
			throw new Error(tooLargeMessage('clean up'));
		}
		const data = await this.app.vault.readBinary(file);
		// Estimate the decoded working set from container metadata BEFORE
		// decodeAudioData materializes the whole PCM: a compact compressed
		// file can pass the byte guard yet decode to an allocation that
		// gets the mobile WebView killed by the OS instead of surfacing a
		// readable error. The post-decode checks stay as the backstop for
		// containers the probe cannot parse.
		await this.rejectOversizedByMetadata(data, file.path);
		const { sampleRate, data: decoded } = await this.decodeChannels(data);
		// Downmix to mono up front, before the DSP stages: the rest of the
		// pipeline is channel-count agnostic, so a mono mode simply leaves
		// one channel to filter/gate/level (and to write), halving that
		// work for a stereo source. Multichannel input only; an already
		// mono file is left as-is.
		const channels =
			isMonoChannelMode(config.channelMode) && decoded.length > 1
				? [downmixChannelData(decoded, config.channelMode)]
				: decoded;
		const numChannels = channels.length;
		// decodeChannels rejects empty audio, so the first channel exists
		const numFrames = channels[0]?.length ?? 0;

		// Allocate the full interleaved 16-bit WAV output once and fill it a
		// segment at a time. Only the decoded input and this output live at full
		// length; each segment's gate/offline working set is released before the
		// next iteration.
		const pcmByteLength = numFrames * numChannels * 2;
		const out = createWavFileBuffer(numChannels, sampleRate, pcmByteLength);
		const pcm = new DataView(out, WAV_HEADER_SIZE);

		const segmentFrames = Math.max(
			1,
			Math.floor(sampleRate * this.segmentSeconds),
		);
		const warmupFrames = Math.floor(sampleRate * CLEANUP_WARMUP_SECONDS);
		for (
			let segStart = 0;
			segStart < numFrames;
			segStart += segmentFrames
		) {
			const segEnd = Math.min(numFrames, segStart + segmentFrames);
			await this.processSegment(
				channels,
				sampleRate,
				config,
				segStart,
				segEnd,
				warmupFrames,
				pcm,
			);
			// Yield to the UI between segments so a long file does not freeze it.
			await delay(0);
		}

		const outputPath = await this.resolveOutputPath(file);
		await this.app.vault.createBinary(outputPath, out);
		return outputPath;
	}

	/**
	 * Processes one time segment and writes its kept frames into the output. The
	 * segment is read with a warm-up lead-in (discarded after processing) so the
	 * stateful gate and offline stages reach the same envelope they would in a
	 * continuous pass, leaving no boundary artifact. The gate runs first, on the
	 * decoded signal, then the high-pass and leveling render offline - the same
	 * order as a whole-file pass, just bounded to one segment.
	 * @param channels - Full decoded per-channel samples (read as views)
	 * @param sampleRate - Sample rate in Hz
	 * @param config - Stages to apply
	 * @param segStart - First frame of the kept region
	 * @param segEnd - End frame (exclusive) of the kept region
	 * @param warmupFrames - Lead-in frames to process and then discard
	 * @param pcm - DataView over the output WAV PCM region
	 */
	private async processSegment(
		channels: Float32Array[],
		sampleRate: number,
		config: AudioDspConfig,
		segStart: number,
		segEnd: number,
		warmupFrames: number,
		pcm: DataView,
	): Promise<void> {
		const inStart = Math.max(0, segStart - warmupFrames);
		// Frames of warm-up at the front of the processed segment to drop.
		const keepFrom = segStart - inStart;
		let segment = channels.map((channel) =>
			channel.subarray(inStart, segEnd),
		);
		if (config.gate.enabled) {
			segment = segment.map((channel) =>
				applyNoiseGateToChannel(
					channel,
					sampleRate,
					config.gate.thresholdDb,
				),
			);
		}
		if (config.highPass.enabled || config.leveling.enabled) {
			segment = await this.renderOffline(segment, sampleRate, config);
		}
		writeWavSegment(pcm, segment, keepFrom, segEnd - segStart, segStart);
	}

	/**
	 * Rejects a file whose DECODED size would blow the platform budget,
	 * using container metadata (duration, sample rate, channels) read
	 * without decoding any PCM. Files whose container the probe cannot
	 * parse pass through - the post-decode checks in decodeChannels
	 * still guard them, at the cost of the decode allocation.
	 * @param data - Encoded file bytes
	 * @param path - Vault path, for the probe's warning log
	 */
	private async rejectOversizedByMetadata(
		data: ArrayBuffer,
		path: string,
	): Promise<void> {
		const metadata = await probeAudioMetadata(data, path);
		// A length the headers do not carry sizes nothing here, so the guard
		// declines rather than reads it as short; decodeChannels still checks
		// the allocation it is about to make.
		if (!metadata || metadata.durationSeconds === null) {
			return;
		}
		const maxSeconds = getMaxCleanupSeconds();
		if (isKnownLongerThan(metadata.durationSeconds, maxSeconds)) {
			throw new Error(
				`Audio is too long to clean up here (limit ${String(
					Math.round(maxSeconds / 60),
				)} minutes). Split it into parts first.`,
			);
		}
		const estimatedSamples =
			Math.ceil(metadata.durationSeconds * metadata.sampleRate) *
			metadata.channels;
		if (estimatedSamples > getMaxCleanupDecodedSamples()) {
			throw new Error(
				'Audio file is too large to clean up here. Split it into parts first.',
			);
		}
	}

	/**
	 * Decodes encoded audio into per-channel Float32 sample arrays.
	 */
	private async decodeChannels(
		data: ArrayBuffer,
	): Promise<{ sampleRate: number; data: Float32Array[] }> {
		const context = new AudioContext();
		try {
			// decodeAudioData detaches its input buffer; that is fine here
			// because `data` is not reused after this call, and avoiding a
			// defensive copy halves peak memory for near-cap files.
			const decoded = await context.decodeAudioData(data);
			const maxSeconds = getMaxCleanupSeconds();
			if (decoded.duration > maxSeconds) {
				throw new Error(
					`Audio is too long to clean up here (limit ${String(
						Math.round(maxSeconds / 60),
					)} minutes). Split it into parts first.`,
				);
			}
			// Reject by decoded working set, not just encoded size: a small
			// compressed file can decode to a multi-gigabyte buffer that the
			// pre-decode byte guard cannot see. Checked before the Float32
			// channels are copied out, so an oversized file fails with a
			// clear message rather than an out-of-memory error mid-pipeline.
			if (
				decoded.length * decoded.numberOfChannels >
				getMaxCleanupDecodedSamples()
			) {
				throw new Error(
					'Audio file is too large to clean up here. Split it into parts first.',
				);
			}
			const channels: Float32Array[] = [];
			for (let i = 0; i < decoded.numberOfChannels; i++) {
				channels.push(Float32Array.from(decoded.getChannelData(i)));
			}
			if ((channels[0]?.length ?? 0) === 0) {
				throw new Error('The file contains no decodable audio data.');
			}
			return { sampleRate: decoded.sampleRate, data: channels };
		} finally {
			void context.close().catch(() => {
				// Closing a context that already failed is non-fatal
			});
		}
	}

	/**
	 * Renders the high-pass and leveling stages through an
	 * OfflineAudioContext and returns the processed channels.
	 */
	private async renderOffline(
		channels: Float32Array[],
		sampleRate: number,
		config: AudioDspConfig,
	): Promise<Float32Array[]> {
		const numChannels = Math.max(1, channels.length);
		const length = channels[0]?.length ?? 0;
		if (length === 0) {
			return channels;
		}
		const offline = new OfflineAudioContext(
			numChannels,
			length,
			sampleRate,
		);
		const buffer = offline.createBuffer(numChannels, length, sampleRate);
		for (let i = 0; i < numChannels; i++) {
			const channel = channels[i];
			if (channel) {
				buffer.getChannelData(i).set(channel);
			}
		}
		const source = offline.createBufferSource();
		source.buffer = buffer;
		let node: AudioNode = source;

		if (config.highPass.enabled) {
			const filter = offline.createBiquadFilter();
			filter.type = 'highpass';
			filter.frequency.value = config.highPass.hz;
			node.connect(filter);
			node = filter;
		}
		if (config.leveling.enabled) {
			const compressor = offline.createDynamicsCompressor();
			compressor.threshold.value = LEVELING_COMPRESSOR_THRESHOLD_DB;
			compressor.knee.value = LEVELING_COMPRESSOR_KNEE_DB;
			compressor.ratio.value = LEVELING_COMPRESSOR_RATIO;
			compressor.attack.value = LEVELING_COMPRESSOR_ATTACK_S;
			compressor.release.value = LEVELING_COMPRESSOR_RELEASE_S;
			node.connect(compressor);
			const makeup = offline.createGain();
			makeup.gain.value = dbToGain(config.leveling.makeupDb);
			compressor.connect(makeup);
			node = makeup;
		}
		node.connect(offline.destination);
		source.start();

		const rendered = await offline.startRendering();
		const result: Float32Array[] = [];
		for (let i = 0; i < rendered.numberOfChannels; i++) {
			result.push(Float32Array.from(rendered.getChannelData(i)));
		}
		return result;
	}

	/**
	 * Resolves a unique `<name>-processed.wav` path next to the source.
	 */
	private resolveOutputPath(file: TFile): Promise<string> {
		const directory = directoryOf(file.path);
		return resolveUniquePathInDirectory(
			directory,
			`${file.basename}-processed.wav`,
			this.app,
		);
	}
}
