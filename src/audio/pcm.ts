/**
 * Shared raw-PCM primitives used by every path that produces or consumes
 * uncompressed samples (recording capture, mixing, splitting, cleanup,
 * transcription chunking).
 *
 * A stream of raw samples is only meaningful together with the way one sample
 * is stored, and that way is a choice the user makes: sixteen bits is what
 * every recording was before the choice existed, twenty-four buys headroom,
 * and thirty-two floating point removes the question of clipping entirely.
 * Everything downstream of the capture worklet - the WAV header, the segment
 * assembly, the streaming mix, the byte-level split - is written against
 * {@link PcmSampleFormat} rather than against sixteen bits.
 * @module audio/pcm
 */

/**
 * How one sample is stored in a raw PCM stream and in the WAV built from it.
 *
 * Stored in data.json, so a value is renamed only with a migration. The keys
 * are declared in the order the dropdown offers them, which is the order
 * `Object.values` hands them back in.
 */
export const PcmSampleFormat = {
	/** Signed 16-bit integer, the representation every earlier recording used. */
	Int16: 'int16',
	/** Signed 24-bit integer, little-endian: eight more bits under the signal. */
	Int24: 'int24',
	/**
	 * 32-bit IEEE float, where full scale is 1.0 and a sample past it is kept
	 * rather than clipped, so an overloaded take is recovered by normalizing
	 * it afterwards.
	 */
	Float32: 'float32',
} as const;

/** One sample representation (derived from {@link PcmSampleFormat}). */
export type PcmSampleFormat =
	(typeof PcmSampleFormat)[keyof typeof PcmSampleFormat];

/** Bytes one sample occupies, per representation. */
export const PCM_SAMPLE_BYTES: Record<PcmSampleFormat, number> = {
	[PcmSampleFormat.Int16]: 2,
	[PcmSampleFormat.Int24]: 3,
	[PcmSampleFormat.Float32]: 4,
};

/** Bits per sample the WAV header states, per representation. */
export const PCM_SAMPLE_BITS: Record<PcmSampleFormat, number> = {
	[PcmSampleFormat.Int16]: 16,
	[PcmSampleFormat.Int24]: 24,
	[PcmSampleFormat.Float32]: 32,
};

/** Bytes per sample for 16-bit PCM. */
export const PCM_BYTES_PER_SAMPLE = PCM_SAMPLE_BYTES[PcmSampleFormat.Int16];

/** Largest signed 16-bit sample value. */
export const INT16_MAX = 32767;

/** Smallest signed 16-bit sample value. */
export const INT16_MIN = -32768;

/** Largest signed 24-bit sample value. */
export const INT24_MAX = 8388607;

/** Smallest signed 24-bit sample value. */
export const INT24_MIN = -8388608;

/**
 * The value a sample sits at when it reaches full scale, per representation.
 *
 * What "as loud as this representation goes" means, which is the figure every
 * level decision is taken against: how far a mix may be summed before it has
 * to be scaled down, and what a track is raised towards when several are
 * brought to a common level.
 */
export const PCM_FULL_SCALE: Record<PcmSampleFormat, number> = {
	[PcmSampleFormat.Int16]: INT16_MAX,
	[PcmSampleFormat.Int24]: INT24_MAX,
	[PcmSampleFormat.Float32]: 1,
};

/**
 * Coerces an untrusted value (settings loaded from disk, a recovery journal
 * written by an older version) to a sample representation, falling back to the
 * sixteen-bit one every recording used before the choice existed.
 * @param value - Candidate value
 * @returns A valid sample representation
 */
export function normalizePcmSampleFormat(value: unknown): PcmSampleFormat {
	return Object.values(PcmSampleFormat).some((format) => format === value)
		? (value as PcmSampleFormat)
		: PcmSampleFormat.Int16;
}

/**
 * Maps a Float32 sample (range -1..1) to a little-endian int16 value. Uses the
 * full negative rail (-32768) for negatives and 32767 for positives, matching
 * the project's int16 mapping (PcmStreamRecorder's capture worklet), rather
 * than scaling both rails by 32767.
 * @param sample - Sample in the range -1..1
 * @returns Signed 16-bit PCM value
 */
export function floatToInt16(sample: number): number {
	const clamped = Math.max(-1, Math.min(1, sample));
	return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/**
 * Root-mean-square amplitude of float samples, on the -1..1 scale a decoded
 * or analysed buffer carries: the level a gate, a meter, or a normalization
 * decision is taken against.
 *
 * Lives here rather than with any one consumer because the recording meter
 * and the live playback chain both read it, and neither should have to reach
 * into the other's module for it.
 * @param samples - Samples in the range -1..1
 * @returns The RMS amplitude, zero for an empty buffer
 */
export function computeRms(samples: Float32Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sumSquares = 0;
	// Iterated rather than indexed: a sample exists at every offset of a typed
	// array, so a read guarded against an absent one is a branch that can never
	// be taken and a coverage figure that can never be whole.
	for (const sample of samples) {
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / samples.length);
}

/**
 * Reads one sample from raw PCM bytes, on the scale its representation works
 * in: a whole number for the integer representations, a share of full scale
 * for the floating point one.
 * @param view - View over the raw sample bytes
 * @param byteOffset - Where the sample starts
 * @param format - How the sample is stored
 * @returns The sample value
 */
export function readPcmSample(
	view: DataView,
	byteOffset: number,
	format: PcmSampleFormat,
): number {
	if (format === PcmSampleFormat.Float32) {
		return view.getFloat32(byteOffset, true);
	}
	if (format === PcmSampleFormat.Int24) {
		// Three bytes of little-endian two's complement, which no DataView
		// accessor covers: the low two carry magnitude and the top one carries
		// the sign, so only that one is read signed.
		return (
			view.getUint8(byteOffset) |
			(view.getUint8(byteOffset + 1) << 8) |
			(view.getInt8(byteOffset + 2) << 16)
		);
	}
	return view.getInt16(byteOffset, true);
}

/**
 * Writes one sample into raw PCM bytes, taking it on the scale its
 * representation works in.
 *
 * An integer representation is rounded and held to its rails, because a value
 * past them wraps into the opposite sign and a single wrapped sample is an
 * audible click. The floating point one is written through untouched: a value
 * past full scale is exactly what it is chosen to keep, and normalizing the
 * finished file brings it back.
 * @param view - View over the raw sample bytes
 * @param byteOffset - Where the sample starts
 * @param format - How the sample is stored
 * @param value - The sample value, on that representation's scale
 */
export function writePcmSample(
	view: DataView,
	byteOffset: number,
	format: PcmSampleFormat,
	value: number,
): void {
	if (format === PcmSampleFormat.Float32) {
		view.setFloat32(byteOffset, value, true);
		return;
	}
	const rounded = Math.round(value);
	if (format === PcmSampleFormat.Int24) {
		const clamped = Math.max(INT24_MIN, Math.min(INT24_MAX, rounded));
		view.setUint8(byteOffset, clamped & 0xff);
		view.setUint8(byteOffset + 1, (clamped >> 8) & 0xff);
		view.setUint8(byteOffset + 2, (clamped >> 16) & 0xff);
		return;
	}
	view.setInt16(
		byteOffset,
		Math.max(INT16_MIN, Math.min(INT16_MAX, rounded)),
		true,
	);
}

/**
 * Reads a whole raw PCM buffer into samples on its representation's own scale.
 *
 * Branches once per buffer rather than once per sample: the two representations
 * a typed array already describes are converted by the engine, and only the
 * three-byte one is walked by hand. A torn trailing sample - a segment flushed
 * mid-frame - is dropped rather than read as a quieter one.
 * @param bytes - Raw interleaved PCM
 * @param format - How one sample is stored
 * @returns The samples, in order
 */
export function decodePcmSamples(
	bytes: ArrayBuffer,
	format: PcmSampleFormat,
): Float32Array {
	const width = PCM_SAMPLE_BYTES[format];
	const count = Math.floor(bytes.byteLength / width);
	if (format === PcmSampleFormat.Float32) {
		return new Float32Array(bytes, 0, count);
	}
	if (format === PcmSampleFormat.Int16) {
		return new Float32Array(new Int16Array(bytes, 0, count));
	}
	const view = new DataView(bytes);
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		samples[i] = readPcmSample(view, i * width, format);
	}
	return samples;
}
