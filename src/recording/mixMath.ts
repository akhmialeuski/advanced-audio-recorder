/**
 * The arithmetic of mixing several tracks into one.
 *
 * Kept apart from the reading and writing so it can be checked directly: a
 * mix that clips, pans the wrong way, or drifts a semitone off is not visible
 * in a file size or a progress bar, and the only honest way to know is to run
 * the numbers.
 * @module recording/mixMath
 */

import { INT16_MAX, INT16_MIN } from '../audio/pcm';

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

/** Quietest track level worth aligning; below it the track is silence. */
const SILENCE_RMS = 1;

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
 * The root mean square of an int16 window, which is what "how loud is this
 * track" means for the purpose of levelling two of them against each other.
 * @param samples - Interleaved int16 samples
 * @param count - How many of them to read
 * @returns The RMS, on the int16 scale
 */
export function windowRms(samples: Int16Array, count: number): number {
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
 * @param rms - The track's measured level, on the int16 scale
 * @returns The multiplier to apply to it
 */
export function normalizeFactor(rms: number): number {
	if (rms <= SILENCE_RMS) {
		return 1;
	}
	return Math.min(MAX_NORMALIZE_GAIN, (INT16_MAX * NORMALIZE_TARGET) / rms);
}

/**
 * The multiplier that brings a summed mix onto the output scale.
 *
 * The sum of several tracks routinely lands past full scale, and clipping it
 * is what turns two people talking at once into distortion. Scaling the whole
 * file by one factor instead keeps the balance between the tracks and costs
 * only level, which is the trade every mixer makes here.
 * @param peak - The largest absolute value the sum reached
 * @returns The multiplier, never above 1
 */
export function outputScale(peak: number): number {
	return peak <= INT16_MAX ? 1 : INT16_MAX / peak;
}

/**
 * Writes an accumulated window onto the output scale, clamping whatever the
 * scale did not catch.
 *
 * The clamp is a floor under a rounding error rather than the level control:
 * with the scale applied, a sample can still land a unit past the edge.
 * @param accumulator - The summed window
 * @param output - Where to write, at the given offset
 * @param outputOffset - First index to write in the output
 * @param count - How many samples to write
 * @param scale - The output multiplier from {@link outputScale}
 */
export function writeScaled(
	accumulator: Int32Array,
	output: Int16Array,
	outputOffset: number,
	count: number,
	scale: number,
): void {
	for (let i = 0; i < count; i++) {
		const scaled = Math.round((accumulator[i] ?? 0) * scale);
		output[outputOffset + i] =
			scaled > INT16_MAX
				? INT16_MAX
				: scaled < INT16_MIN
					? INT16_MIN
					: scaled;
	}
}

/**
 * The state a resampler carries between windows: where in the source it
 * stands, and the frame before it.
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
	/** The last frame of the previous window, one value per channel. */
	previous: Int16Array;
}

/**
 * A resampler's starting state for a track of the given channel count.
 * @param channels - Interleaved channels of the source
 * @returns The state to hand to the first window
 */
export function newResampleState(channels: number): ResampleState {
	return { position: 0, previous: new Int16Array(channels) };
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
	// past the last index is needed. Index -1 is the frame carried from the
	// previous window and is not in the buffer, so the count starts at 0.
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
	source: Int16Array,
	sourceFrames: number,
	target: Int16Array,
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
			// Index -1 is the frame before this window, which the previous
			// call kept: without it the first output frame of every window
			// interpolates from silence and clicks.
			const before =
				index < 0
					? (state.previous[channel] ?? 0)
					: (source[index * channels + channel] ?? 0);
			const after =
				index + 1 < sourceFrames
					? (source[(index + 1) * channels + channel] ?? 0)
					: before;
			target[frame * channels + channel] = Math.round(
				before + (after - before) * fraction,
			);
		}
	}
	// Where the next window starts, expressed against ITS first frame. The
	// reader hands the frames after this window, so the position is measured
	// from there and lands negative whenever this window read further than it
	// consumed. Index -1 then means the last frame of this window, which is
	// what `previous` holds.
	state.position = state.position + outputFrames * ratio - sourceFrames;
	for (let channel = 0; channel < channels; channel++) {
		state.previous[channel] =
			sourceFrames > 0
				? (source[(sourceFrames - 1) * channels + channel] ?? 0)
				: (state.previous[channel] ?? 0);
	}
}
