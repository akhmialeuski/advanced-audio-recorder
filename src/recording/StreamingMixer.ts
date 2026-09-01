/**
 * Bounded-memory mixer for multi-track PCM/WAV sessions. The tracks
 * already sit on disk as raw int16 segments, so they are mixed in
 * fixed-size windows directly into the preallocated WAV file buffer -
 * peak memory is the output file plus one window per track, instead
 * of decoding every track into float32 AudioBuffers and rendering
 * them through an OfflineAudioContext (which costs multiple gigabytes
 * for hour-long multi-track sessions).
 *
 * Tracks at different sample rates are mixed here too, by resampling each
 * one into the highest rate present as it is read. That used to be the
 * Web Audio path's only remaining job on this route, and sending an hour of
 * two-track audio through a full decode because one interface ran at 44100
 * and the other at 48000 cost gigabytes for a difference of ten percent.
 * The Web Audio mix remains the fallback for everything this route still
 * refuses, and which route was taken is logged.
 * @module recording/StreamingMixer
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { createWavFileBuffer, WAV_HEADER_SIZE } from '../audio/WavEncoder';
import { PCM_BYTES_PER_SAMPLE } from '../audio/pcm';
import {
	gainFactor,
	newResampleState,
	normalizeFactor,
	outputScale,
	panGains,
	resampleWindow,
	sourceFramesNeeded,
	windowRms,
	writeScaled,
	type ResampleState,
} from './mixMath';

/** Default mix window in sample frames (~1 MiB stereo int16). */
const DEFAULT_WINDOW_FRAMES = 262144;

/**
 * One PCM track to mix.
 */
export interface PcmMixTrack {
	/** Flushed segment files in capture order. */
	segmentPaths: string[];
	/** Interleaved channel count (1 or 2). */
	channels: number;
	/** Sample rate in Hz. */
	sampleRate: number;
	/** Level adjustment in decibels; absent means the track as captured. */
	gainDb?: number;
	/** Stereo position from -1 (left) to 1 (right); absent means centre. */
	pan?: number;
}

/** One track's captured PCM, as the mix sizing rule reads it. */
export interface PcmMixSize {
	/** Raw int16 PCM captured for this track, in bytes. */
	pcmBytes: number;
	/** Interleaved channel count. */
	channels: number;
	/** Sample rate in Hz. */
	sampleRate: number;
	/** Stereo position of the track; absent means centre. */
	pan?: number;
}

/** The shape of the WAV a mix of a set of tracks produces. */
export interface MixLayout {
	/** Frames the mixed file holds, which is the longest track's. */
	totalFrames: number;
	/** Interleaved channels of the mixed file. */
	outChannels: number;
	/** Sample rate the mixed file is written at. */
	sampleRate: number;
	/** PCM payload of the mixed WAV, in bytes. */
	pcmByteLength: number;
}

/** What the caller may ask of one mix. */
export interface MixOptions {
	/** Told the percentage done, counting both passes. */
	onProgress?: ((percent: number) => void) | undefined;
	/** Mix window size in frames; a test hook. */
	windowFrames?: number | undefined;
	/**
	 * Whether to bring the tracks to a common level before summing. Off by
	 * default: it is a judgement about the recording rather than a property
	 * of it, and a session mixed twice must come out the same both times.
	 */
	alignLevels?: boolean | undefined;
}

/**
 * The WAV a mix of these tracks comes out as.
 *
 * Its own rule rather than an arithmetic the mixer keeps to itself, because
 * the size is asked for twice and from opposite ends: the mixer needs it to
 * allocate, and a running recording needs it to warn before the container
 * ceiling is reached. Mixing up to stereo is what makes the two answers
 * differ from a plain sum, and the case it decides is a long mono track
 * beside a short stereo one, where the mixed file is twice the mono track it
 * is mostly made of.
 *
 * The rate is the highest any track runs at, so resampling only ever
 * interpolates and no track is decimated to suit another. A track placed
 * anywhere but the centre takes the mix to stereo whatever its own channel
 * count: two mono microphones one to each side is the reason panning exists,
 * and a mono file has nowhere to put them.
 * @param tracks - What each track captured, in bytes, channels, and rate
 * @returns The mixed file's frames, channels, rate, and PCM size
 */
export function mixLayout(tracks: readonly PcmMixSize[]): MixLayout {
	if (tracks.length === 0) {
		return {
			totalFrames: 0,
			outChannels: 0,
			sampleRate: 0,
			pcmByteLength: 0,
		};
	}
	const sampleRate = Math.max(...tracks.map((track) => track.sampleRate));
	const totalFrames = Math.max(
		...tracks.map((track) => trackFrames(track, sampleRate)),
	);
	const outChannels = tracks.some((track) => (track.pan ?? 0) !== 0)
		? 2
		: Math.min(2, Math.max(...tracks.map((track) => track.channels)));
	return {
		totalFrames,
		outChannels,
		sampleRate,
		pcmByteLength: totalFrames * outChannels * PCM_BYTES_PER_SAMPLE,
	};
}

/**
 * How many frames one track covers at the rate the mix is written at.
 *
 * A function of its own because it is asked twice and for opposite reasons:
 * the layout takes the longest of them as the length of the whole file, and
 * each track takes its own as the point past which it contributes silence
 * rather than audio.
 * @param track - What the track captured, in bytes, channels, and rate
 * @param sampleRate - Rate the mix is written at
 * @returns The track's own length in frames, at that rate
 */
export function trackFrames(track: PcmMixSize, sampleRate: number): number {
	const frames = Math.floor(
		track.pcmBytes / (PCM_BYTES_PER_SAMPLE * track.channels),
	);
	// A track slower than the output covers the same seconds in fewer frames,
	// and rounding down would drop its last fraction of a window rather than
	// the silence after it.
	return track.sampleRate === sampleRate
		? frames
		: Math.ceil((frames * sampleRate) / track.sampleRate);
}

/**
 * Checks whether the tracks can be mixed by this streaming mixer.
 * @param tracks - Candidate tracks
 * @returns True when every track has data and a channel count that fits
 */
export function canStreamMix(tracks: PcmMixTrack[]): boolean {
	if (tracks.length === 0) {
		return false;
	}
	return tracks.every(
		(track) =>
			track.segmentPaths.length > 0 &&
			track.sampleRate > 0 &&
			track.channels >= 1 &&
			track.channels <= 2,
	);
}

/**
 * Sequential reader over the int16 segments of one track. Reads one
 * segment at a time and serves fixed-size frame windows across
 * segment boundaries.
 */
class PcmSegmentReader {
	private segmentIndex = 0;
	private current: Int16Array | null = null;
	private currentOffset = 0;

	/**
	 * Creates a new PcmSegmentReader.
	 * @param segmentPaths - Segment files in capture order
	 * @param channels - Interleaved channel count
	 * @param app - Obsidian App instance
	 */
	constructor(
		private readonly segmentPaths: string[],
		private readonly channels: number,
		private readonly app: App,
	) {}

	/**
	 * Reads the next window of sample frames into the given buffer,
	 * zero-filling whatever the track can no longer provide.
	 * @param frames - Frames to read
	 * @param window - Reusable buffer of at least frames*channels
	 * @returns Number of samples (not frames) actually read
	 */
	async read(frames: number, window: Int16Array): Promise<number> {
		const samplesWanted = frames * this.channels;
		let written = 0;
		while (written < samplesWanted) {
			if (!this.current || this.currentOffset >= this.current.length) {
				const path = this.segmentPaths[this.segmentIndex];
				if (path === undefined) {
					break;
				}
				const bytes = await this.app.vault.adapter.readBinary(path);
				this.segmentIndex += 1;
				// Whole int16 samples only; a torn trailing byte is dropped
				this.current = new Int16Array(
					bytes,
					0,
					Math.floor(bytes.byteLength / PCM_BYTES_PER_SAMPLE),
				);
				this.currentOffset = 0;
			}
			const available = this.current.length - this.currentOffset;
			const take = Math.min(available, samplesWanted - written);
			window.set(
				this.current.subarray(
					this.currentOffset,
					this.currentOffset + take,
				),
				written,
			);
			this.currentOffset += take;
			written += take;
		}
		window.fill(0, written, samplesWanted);
		return written;
	}
}

/**
 * One track, read at the rate the mix is written at.
 *
 * A track already at the output rate is handed through untouched, so the
 * common session pays nothing for the capability: the resampler is only
 * built for a track whose rate differs, and the phase it carries between
 * windows is what keeps a window boundary from becoming a click.
 */
class TrackWindowReader {
	/** The segments underneath, read at the track's own rate. */
	private readonly reader: PcmSegmentReader;

	/** Where the resampler stands; null for a track needing none. */
	private readonly state: ResampleState | null;

	/** Source frames, for a track being resampled. */
	private readonly source: Int16Array | null;

	/** The window handed to the caller, at the output rate. */
	readonly window: Int16Array;

	/**
	 * @param track - The track to read
	 * @param outputRate - Rate the mix is written at
	 * @param windowFrames - Output frames per window
	 * @param app - Obsidian App instance
	 */
	constructor(
		private readonly track: PcmMixTrack,
		private readonly outputRate: number,
		windowFrames: number,
		app: App,
	) {
		this.reader = new PcmSegmentReader(
			track.segmentPaths,
			track.channels,
			app,
		);
		this.window = new Int16Array(windowFrames * track.channels);
		if (track.sampleRate === outputRate) {
			this.state = null;
			this.source = null;
			return;
		}
		this.state = newResampleState(track.channels);
		// A source slower than the output needs at most one frame per output
		// frame, plus the one the last interpolation reaches into.
		this.source = new Int16Array((windowFrames + 2) * track.channels);
	}

	/** The ratio of the track's rate to the output's. */
	private get ratio(): number {
		return this.track.sampleRate / this.outputRate;
	}

	/**
	 * Fills {@link window} with the next frames at the output rate.
	 * @param frames - Output frames wanted
	 */
	async read(frames: number): Promise<void> {
		const { state, source } = this;
		if (!state || !source) {
			await this.reader.read(frames, this.window);
			return;
		}
		const needed = sourceFramesNeeded(frames, this.ratio, state);
		await this.reader.read(needed, source);
		resampleWindow(
			source,
			needed,
			this.window,
			frames,
			this.track.channels,
			this.ratio,
			state,
		);
	}
}

/**
 * One track as the mix reads it: where its samples come from, how loud they
 * turned out to be, and what it is multiplied by on the way into the sum.
 *
 * One object per track rather than a set of arrays indexed in lockstep. The
 * arrays were the same thing spread over five places, each needing a guard
 * saying the index exists in all of them, which is a guarantee the shape
 * itself can give instead.
 */
interface MixLane {
	/** The track this lane carries. */
	readonly track: PcmMixTrack;
	/**
	 * Frames the track itself captured, at the output rate. A track shorter
	 * than the mix is read out as silence past this point, and that silence
	 * belongs to the mix rather than to the track.
	 */
	readonly frames: number;
	/** Reader at the output rate; replaced between the two passes. */
	reader: TrackWindowReader;
	/** Sum of the squared samples seen, which becomes the track's level. */
	squares: number;
	/** How many samples that sum covers. */
	count: number;
	/** Largest absolute sample seen. */
	peak: number;
	/** Multiplier into the left, or only, output channel. */
	left: number;
	/** Multiplier into the right output channel. */
	right: number;
}

/**
 * Adds one lane's window into the accumulator, at the multipliers the lane
 * currently carries.
 *
 * Both passes go through here: the measuring pass to learn what the sum
 * actually reaches, and the mixing pass to write it. One implementation,
 * because any difference between the two would leave the measurement
 * describing a mix that was never written.
 * @param lane - The track to add, whose window has already been read
 * @param accumulator - The window being summed into
 * @param frames - Frames to add
 * @param outChannels - Interleaved channels of the mix
 */
function accumulateLane(
	lane: MixLane,
	accumulator: Int32Array,
	frames: number,
	outChannels: number,
): void {
	const window = lane.reader.window;
	// The `?? 0` narrows the checked index reads with the mix's neutral
	// element; every access below is in bounds by construction (the buffers
	// are sized from windowFrames)
	if (outChannels === 1) {
		for (let i = 0; i < frames; i++) {
			accumulator[i] =
				(accumulator[i] ?? 0) +
				Math.round((window[i] ?? 0) * lane.left);
		}
		return;
	}
	if (lane.track.channels === 2) {
		for (let frame = 0; frame < frames; frame++) {
			accumulator[frame * 2] =
				(accumulator[frame * 2] ?? 0) +
				Math.round((window[frame * 2] ?? 0) * lane.left);
			accumulator[frame * 2 + 1] =
				(accumulator[frame * 2 + 1] ?? 0) +
				Math.round((window[frame * 2 + 1] ?? 0) * lane.right);
		}
		return;
	}
	// Mono into stereo: the sample reaches both channels, in the proportion
	// the pan asks for
	for (let frame = 0; frame < frames; frame++) {
		const sample = window[frame] ?? 0;
		accumulator[frame * 2] =
			(accumulator[frame * 2] ?? 0) + Math.round(sample * lane.left);
		accumulator[frame * 2 + 1] =
			(accumulator[frame * 2 + 1] ?? 0) + Math.round(sample * lane.right);
	}
}

/**
 * Gives each lane the multipliers that are known before a sample is read: the
 * track's own gain, and where its pan puts it.
 *
 * Level alignment is not among them, because it is measured from the track
 * itself, so a mix that aligns levels has its multipliers completed afterwards
 * in {@link planMix}.
 * @param lanes - The tracks to place
 * @param outChannels - Interleaved channels of the mix
 */
function placeLanes(lanes: readonly MixLane[], outChannels: number): void {
	for (const lane of lanes) {
		const level = gainFactor(lane.track.gainDb ?? 0);
		// A mono mix has one channel to place a track in, so panning it would
		// only make it quieter.
		const pan =
			outChannels === 2
				? panGains(lane.track.pan ?? 0)
				: { left: 1, right: 1 };
		lane.left = level * pan.left;
		lane.right = level * pan.right;
	}
}

/**
 * Reads every track once: how loud each one is on its own, and how loud they
 * are together.
 *
 * The pass exists so the second one can write at a multiplier that is known
 * before the first sample is written, which is the whole difference between
 * scaling a loud mix and clipping it. Summing the tracks here as well is what
 * makes that multiplier the true one. The alternative, adding up the peaks of
 * the separate tracks, assumes they all peak on the same frame: two people on
 * two microphones take turns speaking and never do, so the bound came out
 * around twice the real peak and quietened by several decibels a mix that
 * would not have clipped at all.
 * @param lanes - The tracks, whose measurements are filled in
 * @param totalFrames - Frames the mix holds
 * @param windowFrames - Frames per window
 * @param outChannels - Interleaved channels of the mix
 * @param onWindow - Told the frames measured so far
 * @returns The largest absolute value the summed mix reached
 */
async function measureTracks(
	lanes: readonly MixLane[],
	totalFrames: number,
	windowFrames: number,
	outChannels: number,
	onWindow: (framesDone: number) => void,
): Promise<number> {
	const accumulator = new Int32Array(windowFrames * outChannels);
	let summedPeak = 0;
	let frameOffset = 0;
	while (frameOffset < totalFrames) {
		const frames = Math.min(windowFrames, totalFrames - frameOffset);
		accumulator.fill(0, 0, frames * outChannels);
		for (const lane of lanes) {
			await lane.reader.read(frames);
			// Measured over what the track captured and no further. A track
			// shorter than the mix is read out as silence to the end, and
			// counting that silence as part of the track understates how loud
			// it is, which had the level alignment raise a participant who
			// joined half way through above everyone who was there throughout.
			const measured = Math.max(
				0,
				Math.min(frames, lane.frames - frameOffset),
			);
			const samples = measured * lane.track.channels;
			const rms = windowRms(lane.reader.window, samples);
			lane.squares += rms * rms * samples;
			lane.count += samples;
			for (let i = 0; i < samples; i++) {
				lane.peak = Math.max(
					lane.peak,
					Math.abs(lane.reader.window[i] ?? 0),
				);
			}
			// The whole window is summed even so, because the silence a track
			// runs out into is genuinely part of the mix.
			accumulateLane(lane, accumulator, frames, outChannels);
		}
		// Walked as a view rather than by index: iterating a typed array
		// yields a number, where an indexed read yields one that might be
		// missing and needs a fallback no sample can ever reach.
		for (const sample of accumulator.subarray(0, frames * outChannels)) {
			summedPeak = Math.max(summedPeak, Math.abs(sample));
		}
		frameOffset += frames;
		onWindow(frameOffset);
	}
	return summedPeak;
}

/**
 * Completes the multipliers that needed the measurement to be known, and
 * answers with the one the sum is written at.
 *
 * Without level alignment every multiplier was already in force while the
 * tracks were measured, so the peak that pass found is the peak this mix will
 * reach and the scale is exact: a mix that would have clipped is scaled down
 * whole instead of having its loudest moments flattened, and a mix that never
 * approached full scale is written exactly as it was captured.
 *
 * Alignment multiplies each track by a figure derived from its own level,
 * which is known only once the measuring pass has finished, so what that pass
 * summed is no longer what will be written. Only that case falls back to the
 * peaks of the separate tracks: a bound that can never clip, at the cost of
 * quietening a mix whose tracks peak at different moments.
 * @param lanes - The measured tracks, whose multipliers are completed
 * @param alignLevels - Whether to bring the tracks to a common level
 * @param summedPeak - The peak the measuring pass found for the sum
 * @returns The multiplier the sum is written at
 */
function planMix(
	lanes: readonly MixLane[],
	alignLevels: boolean,
	summedPeak: number,
): number {
	if (!alignLevels) {
		return outputScale(summedPeak);
	}
	let leftPeak = 0;
	let rightPeak = 0;
	for (const lane of lanes) {
		const level = normalizeFactor(
			Math.sqrt(lane.squares / Math.max(1, lane.count)),
		);
		lane.left *= level;
		lane.right *= level;
		leftPeak += lane.peak * lane.left;
		rightPeak += lane.peak * lane.right;
	}
	return outputScale(Math.max(leftPeak, rightPeak));
}

/**
 * Mixes the given PCM tracks into one complete WAV file buffer.
 *
 * Output is mono when every input is mono, stereo otherwise (mono inputs are
 * duplicated into both channels); the rate is the highest any track runs at,
 * and slower tracks are resampled into it; the length is the longest track,
 * with shorter tracks padded by silence. Each track is placed by its own gain
 * and pan, and the sum is scaled onto the output range rather than clipped
 * against it.
 * @param tracks - Tracks to mix (validate with canStreamMix first)
 * @param app - Obsidian App instance
 * @param options - Progress, window size, and whether to align levels
 * @returns Complete WAV file bytes
 * @throws Error when the adapter cannot report segment sizes (the
 * caller falls back to the Web Audio mixing path)
 */
export async function mixPcmTracksToWav(
	tracks: PcmMixTrack[],
	app: App,
	options: MixOptions = {},
): Promise<ArrayBuffer> {
	const adapter = app.vault.adapter;
	if (typeof adapter.stat !== 'function') {
		throw new Error(
			'Vault adapter cannot report file sizes for streaming mix',
		);
	}
	const windowFrames = options.windowFrames ?? DEFAULT_WINDOW_FRAMES;

	if (tracks.length === 0) {
		throw new Error('No tracks to mix');
	}
	// Captured bytes per track from the segment sizes on disk, kept paired
	// with the track they were measured from: the lane below needs both, and
	// two arrays walked by index is the shape that lets them drift apart.
	const sized: { track: PcmMixTrack; size: PcmMixSize }[] = [];
	for (const track of tracks) {
		let bytes = 0;
		for (const path of track.segmentPaths) {
			const stat = await adapter.stat(path);
			if (!stat) {
				throw new Error('PCM segment is missing for the streaming mix');
			}
			bytes += stat.size;
		}
		sized.push({
			track,
			size: {
				pcmBytes: bytes,
				channels: track.channels,
				sampleRate: track.sampleRate,
				...(track.pan === undefined ? {} : { pan: track.pan }),
			},
		});
	}
	const { totalFrames, outChannels, sampleRate, pcmByteLength } = mixLayout(
		sized.map((entry) => entry.size),
	);

	const wavBuffer = createWavFileBuffer(
		outChannels,
		sampleRate,
		pcmByteLength,
	);
	const output = new Int16Array(wavBuffer, WAV_HEADER_SIZE);

	// Both passes read the same windows, so each reports half the progress.
	const reportPass = (pass: number) => (framesDone: number) => {
		options.onProgress?.(
			Math.round(((pass + framesDone / totalFrames) / 2) * 100),
		);
	};
	const newReader = (track: PcmMixTrack): TrackWindowReader =>
		new TrackWindowReader(track, sampleRate, windowFrames, app);
	const lanes: MixLane[] = sized.map(({ track, size }) => ({
		track,
		frames: trackFrames(size, sampleRate),
		reader: newReader(track),
		squares: 0,
		count: 0,
		peak: 0,
		left: 1,
		right: 1,
	}));

	// Placed before the measuring pass, so the sum that pass measures is the
	// sum this mix will write.
	placeLanes(lanes, outChannels);
	const summedPeak = await measureTracks(
		lanes,
		totalFrames,
		windowFrames,
		outChannels,
		reportPass(0),
	);
	const scale = planMix(lanes, options.alignLevels === true, summedPeak);

	// The readers are sequential and have reached the end of their tracks.
	for (const lane of lanes) {
		lane.reader = newReader(lane.track);
	}
	const accumulator = new Int32Array(windowFrames * outChannels);
	const report = reportPass(1);

	let frameOffset = 0;
	while (frameOffset < totalFrames) {
		const frames = Math.min(windowFrames, totalFrames - frameOffset);
		accumulator.fill(0, 0, frames * outChannels);

		for (const lane of lanes) {
			await lane.reader.read(frames);
			accumulateLane(lane, accumulator, frames, outChannels);
		}

		writeScaled(
			accumulator,
			output,
			frameOffset * outChannels,
			frames * outChannels,
			scale,
		);

		frameOffset += frames;
		report(frameOffset);
	}
	console.debug(
		`${PLUGIN_LOG_PREFIX} Mixed ${String(tracks.length)} tracks at ${String(sampleRate)} Hz, output scaled by ${scale.toFixed(3)}.`,
	);

	return wavBuffer;
}
