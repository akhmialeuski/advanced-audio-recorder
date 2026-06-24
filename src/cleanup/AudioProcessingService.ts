/**
 * On-demand audio cleanup: decode an existing audio file, apply the
 * selected DSP stages (noise gate, high-pass filter, loudness leveling)
 * offline, and write a processed WAV copy next to the source. Invoked
 * from the context menu — it never runs during live recording.
 * @module cleanup/AudioProcessingService
 */

import type { App, TFile } from 'obsidian';
import {
	MAX_AUDIO_CLEANUP_BYTES,
	MAX_AUDIO_CLEANUP_SECONDS,
} from '../constants';
import { createWavHeader, WAV_HEADER_SIZE } from '../recording/WavEncoder';
import { resolveUniquePathInDirectory } from '../recording/RecordingFileManager';
import {
	applyNoiseGateToChannel,
	dbToGain,
	type AudioDspConfig,
} from './audioDsp';

/** Loudness-leveling compressor curve, fixed and tuned for speech. */
const LEVELING_COMPRESSOR_THRESHOLD_DB = -24;
const LEVELING_COMPRESSOR_KNEE_DB = 30;
const LEVELING_COMPRESSOR_RATIO = 12;
const LEVELING_COMPRESSOR_ATTACK_S = 0.003;
const LEVELING_COMPRESSOR_RELEASE_S = 0.25;

/**
 * Encodes per-channel Float32 samples (range -1..1) into an interleaved
 * 16-bit PCM WAV file.
 * @param channels - Per-channel sample data (all the same length)
 * @param sampleRate - Sample rate in Hz
 * @returns WAV-encoded bytes
 */
export function encodeWavInterleaved(
	channels: Float32Array[],
	sampleRate: number,
): ArrayBuffer {
	const numChannels = Math.max(1, channels.length);
	const numFrames = channels[0]?.length ?? 0;
	const pcmByteLength = numFrames * numChannels * 2;
	const header = createWavHeader(numChannels, sampleRate, pcmByteLength);
	const out = new ArrayBuffer(WAV_HEADER_SIZE + pcmByteLength);
	new Uint8Array(out).set(new Uint8Array(header), 0);
	const view = new DataView(out, WAV_HEADER_SIZE);
	let offset = 0;
	for (let frame = 0; frame < numFrames; frame++) {
		for (let channel = 0; channel < numChannels; channel++) {
			const sample = channels[channel][frame];
			const clamped = Math.max(-1, Math.min(1, sample));
			view.setInt16(offset, Math.round(clamped * 0x7fff), true);
			offset += 2;
		}
	}
	return out;
}

/**
 * Runs the offline audio-cleanup pipeline.
 */
export class AudioProcessingService {
	constructor(private readonly app: App) {}

	/**
	 * Processes an audio file and writes a cleaned WAV copy.
	 * @param file - Source audio file
	 * @param config - Stages to apply
	 * @returns Vault path of the written file
	 */
	async process(file: TFile, config: AudioDspConfig): Promise<string> {
		if (file.stat.size > MAX_AUDIO_CLEANUP_BYTES) {
			throw new Error(
				'Audio file is too large to clean up here. Split it into parts first.',
			);
		}
		const data = await this.app.vault.readBinary(file);
		const decoded = await this.decodeChannels(data);
		const sampleRate = decoded.sampleRate;
		let samples = decoded.data;

		if (config.gate.enabled) {
			samples = samples.map((channel) =>
				applyNoiseGateToChannel(
					channel,
					sampleRate,
					config.gate.thresholdDb,
				),
			);
		}
		if (config.highPass.enabled || config.leveling.enabled) {
			samples = await this.renderOffline(samples, sampleRate, config);
		}

		const wav = encodeWavInterleaved(samples, sampleRate);
		const outputPath = await this.resolveOutputPath(file);
		await this.app.vault.createBinary(outputPath, wav);
		return outputPath;
	}

	/**
	 * Decodes encoded audio into per-channel Float32 sample arrays.
	 */
	private async decodeChannels(
		data: ArrayBuffer,
	): Promise<{ sampleRate: number; data: Float32Array[] }> {
		const context = new AudioContext();
		try {
			const decoded = await context.decodeAudioData(data.slice(0));
			if (decoded.duration > MAX_AUDIO_CLEANUP_SECONDS) {
				throw new Error(
					`Audio is too long to clean up here (limit ${String(
						Math.round(MAX_AUDIO_CLEANUP_SECONDS / 60),
					)} minutes). Split it into parts first.`,
				);
			}
			const channels: Float32Array[] = [];
			for (let i = 0; i < decoded.numberOfChannels; i++) {
				channels.push(Float32Array.from(decoded.getChannelData(i)));
			}
			if (channels.length === 0 || channels[0].length === 0) {
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
			buffer.getChannelData(i).set(channels[i]);
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
	private async resolveOutputPath(file: TFile): Promise<string> {
		const slash = file.path.lastIndexOf('/');
		const directory = slash >= 0 ? file.path.slice(0, slash) : '';
		return resolveUniquePathInDirectory(
			directory,
			`${file.basename}-processed.wav`,
			this.app,
		);
	}
}
