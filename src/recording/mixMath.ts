/**
 * The arithmetic of mixing several tracks into one.
 *
 * Kept apart from the reading and writing so it can be checked directly: a
 * mix that clips, pans the wrong way, or drifts a semitone off is not visible
 * in a file size or a progress bar, and the only honest way to know is to run
 * the numbers.
 * @module recording/mixMath
 */

import {
	INT16_MAX,
	PCM_SAMPLE_BYTES,
	writePcmSample,
	type PcmSampleFormat,
} from '../audio/pcm';

/** Loudest a normalised track is raised to, as a share of full scale. */
const NORMALIZE_TARGET = 0.25;

/**
 * Most a track may be raised by level alignment.
 *
 * Without a ceiling, a track that is nearly silent - a muted microphone, a
 * participant who never spoke - is multiplied by whatever it takes to reach
 * the target, which is a way of turning its noise floor into the loudest
 * thing in the mix.
 */
const MAX_NORMALIZE_GAIN = 8;

/**
 * Quietest track level worth aligning, as a share of full scale.
 *
 * One unit of a sixteen-bit sample, which is the quietest thing that
 * representation can express at all. A track below it carries no signal in any
 * representation, and raising it only raises its noise floor.
 */
const SILENCE_RMS_SHARE = 1 / INT16_MAX;

/**
 * The multiplier a gain in decibels means.
 * @param db - Gain in decibels; 0 leaves the track as it is
 * @returns The linear multiplier
 */
export function gainFactor(db: number): number {
	return db === 0 ? 1 : 10 ** (db / 20);
}

/**
 * How much of a track reaches each output channel at a pan position.
 *
 * A balance law rather than a constant-power one: at the centre both sides
 * are 1, so a track nobody panned sounds exactly as it did before panning
 * existed. Constant power would put the centre at 0.707 and quieten every
 * existing mix by 3 dB to buy a smoothness that speech does not need.
 * @param pan - -1 hard left, 0 centre, 1 hard right
 * @returns The multiplier for each output channel
 */
export function panGains(pan: number): { left: number; right: number } {
	const clamped = Math.max(-1, Math.min(1, pan));
	return {
		left: Math.min(1, 1 - clamped),
		right: Math.min(1, 1 + clamped),
	};
}

/**
 * The root mean square of a window, which is what "how loud is this track"
 * means for the purpose of levelling two of them against each other.
 * @param samples - Interleaved samples, on their representation's own scale
 * @param count - How many of them to read
 * @returns The RMS, on that same scale
 */
export function windowRms(samples: Float32Array, count: number): number {
	if (count <= 0) {
		return 0;
	}
	let sum = 0;
	for (let i = 0; i < count; i++) {
		const sample = samples[i] ?? 0;
		sum += sample * sample;
	}
	return Math.sqrt(sum / count);
}

/**
 * The multiplier that brings a track to the shared level.
 *
 * A track quieter than the noise it carries is left alone, and no track is
 * raised past the ceiling: both cases are a microphone that captured nothing
 * worth hearing, and multiplying it up only makes its hiss audible.
 *
 * The level and the scale it is measured against have to be the same one, and
 * which one that is differs per route: the streaming mixer reads samples on the
 * scale its representation works in, while a decoded buffer is already a share
 * of full scale. The default keeps the sixteen-bit scale every caller spoke
 * before the width became a choice.
 * @param rms - The track's measured level
 * @param fullScale - The value a sample at full scale carries on that scale
 * @returns The multiplier to apply to it
 */
export function normalizeFactor(
	rms: number,
	fullScale: number = INT16_MAX,
): number {
	if (rms <= SILENCE_RMS_SHARE * fullScale) {
		return 1;
	}
	return Math.min(MAX_NORMALIZE_GAIN, (fullScale * NORMALIZE_TARGET) / rms);
}

/**
 * The multiplier that brings a summed mix onto the output scale.
 *
 * The sum of several tracks routinely lands past full scale, and clipping it
 * is what turns two people talking at once into distortion. Scaling the whole
 * file by one factor instead keeps the balance between the tracks and costs
 * only level, which is the trade every mixer makes here.
 *
 * The floating point representation would survive a sum past full scale, and is
 * scaled all the same: full scale is where a player stops, so a mix left above
 * it plays as distortion however faithfully the file holds it.
 * @param peak - The largest absolute value the sum reached
 * @param fullScale - The value a sample at full scale carries on that scale
 * @returns The multiplier, never above 1
 */
export function outputScale(
	peak: number,
	fullScale: number = INT16_MAX,
): number {
	return peak <= fullScale ? 1 : fullScale / peak;
}

/** The sample data a mixed window is written into, and how it is stored. */
export interface PcmWriteTarget {
	/** View over the sample region of the file being written. */
	readonly view: DataView;
	/** How one sample is stored there. */
	readonly format: PcmSampleFormat;
}

/**
 * Writes an accumulated window onto the output scale.
 *
 * The window is summed in full precision and quantized once, here: rounding
 * each track's contribution on the way in would put a rounding error under
 * every sample of every track instead of one under each sample of the mix.
 * Holding a sample to the rails of an integer representation is
 * {@link module:audio/pcm.writePcmSample}'s job, and is a floor under a
 * rounding error rather than the level control: with the scale applied, a
 * sample can still land a unit past the edge.
 * @param accumulator - The summed window
 * @param target - Where to write, and the representation to write in
 * @param outputOffset - First sample index to write in the output
 * @param count - How many samples to write
 * @param scale - The output multiplier from {@link outputScale}
 */
export function writeScaled(
	accumulator: Float64Array,
	target: PcmWriteTarget,
	outputOffset: number,
	count: number,
	scale: number,
): void {
	const width = PCM_SAMPLE_BYTES[target.format];
	// Walked as a view rather than by index: iterating a typed array yields a
	// number, where an indexed read yields one that might be missing and needs
	// a fallback no sample can ever reach.
	accumulator.subarray(0, count).forEach((value, index) => {
		writePcmSample(
			target.view,
			(outputOffset + index) * width,
			target.format,
			value * scale,
		);
	});
}

/**
 * Frames kept from the previous window, which the interpolation reaches back
 * into.
 *
 * Two, not one. The advance below leaves `position` in [ratio - 2, ratio - 1),
 * so at a ratio that is not a neat fraction the first output frame of a window
 * routinely interpolates between source indices -2 and -1, and both of them sit
 * in the window that has already been read and handed back.
 */
const CARRIED_FRAMES = 2;

/**
 * The state a resampler carries between windows: where in the source it
 * stands, and the frames before it.
 *
 * Both are needed because a window boundary falls in the middle of the
 * interpolation. Dropping either restarts the phase at every window, which is
 * a click at every boundary and a drift that accumulates over an hour.
 */
export interface ResampleState {
	/**
	 * Where the next output frame falls, measured from the first frame of
	 * the window about to be read. Negative when the previous window read
	 * further than it consumed, which is the usual case.
	 */
	position: number;
	/**
	 * The last {@link CARRIED_FRAMES} frames of the previous window,
	 * interleaved: the older frame first, then the last one.
	 */
	previous: Float32Array;
}

/**
 * A resampler's starting state for a track of the given channel count.
 * @param channels - Interleaved channels of the source
 * @returns The state to hand to the first window
 */
export function newResampleState(channels: number): ResampleState {
	return {
		position: 0,
		previous: new Float32Array(channels * CARRIED_FRAMES),
	};
}

/**
 * Reads one interleaved frame, where a negative index reaches into the frames
 * carried from the previous window: -1 is its last frame and -2 the one before
 * it.
 *
 * Reading the carry through the same call as the window is what keeps the two
 * ends of a boundary in step. Written as two separate lookups, the pair that
 * spans the boundary took one sample from the carry and the other from a source
 * index that does not exist, which silently became a zero.
 * @param source - Source frames, interleaved
 * @param state - Where the resampler stands, holding the carried frames
 * @param index - Frame index, negative for the carried frames
 * @param channel - Channel to read
 * @param channels - Interleaved channels of the source
 * @returns The sample, or the oldest carried one where the index runs past it
 */
function frameAt(
	source: Float32Array,
	state: ResampleState,
	index: number,
	channel: number,
	channels: number,
): number {
	if (index >= 0) {
		return source[index * channels + channel] ?? 0;
	}
	// Clamped rather than answered with silence. The phase cannot fall further
	// back than the carry, and were it ever to, the oldest sample actually held
	// is a better answer than a zero dropped into the middle of a track.
	const slot = Math.max(0, index + CARRIED_FRAMES);
	return state.previous[slot * channels + channel] ?? 0;
}

/**
 * How many source frames a window of output frames needs.
 *
 * One more than the ratio implies, because the last output frame
 * interpolates between two source frames and the second of them is the one
 * after the range.
 * @param outputFrames - Output frames wanted
 * @param ratio - Source rate divided by output rate
 * @param state - Where the resampler stands
 * @returns Source frames to read
 */
export function sourceFramesNeeded(
	outputFrames: number,
	ratio: number,
	state: ResampleState,
): number {
	if (outputFrames <= 0) {
		return 0;
	}
	// The last output frame interpolates between two source frames, so one
	// past the last index is needed. A negative index is a frame carried from
	// the previous window and is not in the buffer, so the count starts at 0.
	return Math.max(
		0,
		Math.floor(state.position + (outputFrames - 1) * ratio) + 2,
	);
}

/**
 * Resamples one window by linear interpolation, carrying the phase and the
 * last frame into the next call.
 *
 * Linear rather than something better on purpose. The alternatives here are a
 * resampler this project cannot reach (mediabunny ships one but does not
 * export it, and its package exports map opens only the root) and an
 * OfflineAudioContext, which mediabunny's own documentation warns gives
 * unstable results across consecutive segments - exactly the case here. For
 * speech at the rates capture devices actually run at, the audible difference
 * is nothing next to reading the whole session into memory instead.
 * @param source - Source frames, interleaved
 * @param sourceFrames - How many frames of it are valid
 * @param target - Where to write the resampled frames
 * @param outputFrames - Output frames to produce
 * @param channels - Interleaved channels of both
 * @param ratio - Source rate divided by output rate
 * @param state - Carried between windows; updated in place
 */
export function resampleWindow(
	source: Float32Array,
	sourceFrames: number,
	target: Float32Array,
	outputFrames: number,
	channels: number,
	ratio: number,
	state: ResampleState,
): void {
	for (let frame = 0; frame < outputFrames; frame++) {
		const position = state.position + frame * ratio;
		const index = Math.floor(position);
		const fraction = position - index;
		for (let channel = 0; channel < channels; channel++) {
			// A negative index is a frame before this window, which the
			// previous call kept: without them the opening output frames of
			// every window interpolate from silence and click.
			const before = frameAt(source, state, index, channel, channels);
			const after =
				index + 1 < sourceFrames
					? frameAt(source, state, index + 1, channel, channels)
					: before;
			// Not quantized here: the window it feeds is summed with the other
			// tracks and written once, and rounding a track on the way into
			// that sum only puts an error under it that the sum then carries.
			target[frame * channels + channel] =
				before + (after - before) * fraction;
		}
	}
	// Where the next window starts, expressed against ITS first frame. The
	// reader hands the frames after this window, so the position is measured
	// from there and lands negative whenever this window read further than it
	// consumed. A negative index then means one of this window's closing
	// frames, which is what `previous` carries.
	state.position = state.position + outputFrames * ratio - sourceFrames;
	for (let channel = 0; channel < channels; channel++) {
		// Both read before either is written: a window shorter than the carry
		// leaves the new carry reaching back into the old one.
		const last = frameAt(
			source,
			state,
			sourceFrames - 1,
			channel,
			channels,
		);
		const prior = frameAt(
			source,
			state,
			sourceFrames - 2,
			channel,
			channels,
		);
		state.previous[channel] = prior;
		state.previous[channels + channel] = last;
	}
}
