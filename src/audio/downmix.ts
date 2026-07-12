/**
 * Channel-layout modes and pure downmix helpers shared by every path
 * that can reduce audio to mono: live capture (the PCM worklet and the
 * MediaRecorder mono bridge) and file conversion (the streaming
 * mediabunny pipeline and the decode-and-re-encode fallback).
 *
 * The dedicated left/right modes exist because audio interfaces with
 * two mono inputs expose themselves as one stereo device; a voice
 * recorded through such an interface sits entirely in one channel, and
 * averaging it with the silent channel would lose 6 dB of level.
 *
 * The mix mode is defined as the plain average of all input channels,
 * and every pipeline implements exactly that definition: this module's
 * helpers, the PCM capture worklet (PcmStreamRecorder), the live
 * MediaRecorder bridge (MonoCaptureBridge), and the streaming
 * conversion hook (averageChannelsSample). For stereo it equals the
 * Web Audio speaker rule of 0.5*(L+R); for 5.1-style layouts it
 * deliberately differs from the speaker rules, which weight channels
 * and drop the LFE.
 * @module audio/downmix
 */

/** Keep the channel layout the capture device or source file provides. */
export const CHANNEL_MODE_SOURCE = 'source';

/** Mix all input channels into one (average, Web Audio downmix rule). */
export const CHANNEL_MODE_MONO_MIX = 'mono-mix';

/** Keep only the first (left) input channel. */
export const CHANNEL_MODE_MONO_LEFT = 'mono-left';

/** Keep only the second (right) input channel. */
export const CHANNEL_MODE_MONO_RIGHT = 'mono-right';

/** Every supported channel mode, in UI order. */
export const CHANNEL_MODES = [
	CHANNEL_MODE_SOURCE,
	CHANNEL_MODE_MONO_MIX,
	CHANNEL_MODE_MONO_LEFT,
	CHANNEL_MODE_MONO_RIGHT,
] as const;

/** A channel-layout mode (derived from {@link CHANNEL_MODES}). */
export type ChannelMode = (typeof CHANNEL_MODES)[number];

/**
 * Type guard for {@link ChannelMode} values.
 * @param value - Candidate value
 */
export function isChannelMode(value: unknown): value is ChannelMode {
	return (
		typeof value === 'string' &&
		(CHANNEL_MODES as readonly string[]).includes(value)
	);
}

/**
 * Coerces an untrusted value (settings loaded from disk, worker
 * messages) to a valid channel mode, falling back to the pass-through
 * source mode.
 * @param value - Candidate value
 */
export function normalizeChannelMode(value: unknown): ChannelMode {
	return isChannelMode(value) ? value : CHANNEL_MODE_SOURCE;
}

/**
 * Whether the mode reduces the audio to one channel.
 * @param mode - Channel mode
 */
export function isMonoChannelMode(mode: ChannelMode): boolean {
	return mode !== CHANNEL_MODE_SOURCE;
}

/**
 * Resolves which single input channel a picking mode keeps, clamped to
 * the channels that actually exist so a right-channel pick on a mono
 * input degrades to the only available channel instead of silence.
 * @param mode - Channel mode
 * @param availableChannels - Number of channels the input provides
 * @returns Zero-based channel index, or null when the mode does not
 * pick a single channel (source pass-through and the mono mix)
 */
export function monoPickIndex(
	mode: ChannelMode,
	availableChannels: number,
): number | null {
	if (mode !== CHANNEL_MODE_MONO_LEFT && mode !== CHANNEL_MODE_MONO_RIGHT) {
		return null;
	}
	const wanted = mode === CHANNEL_MODE_MONO_RIGHT ? 1 : 0;
	return Math.max(0, Math.min(wanted, availableChannels - 1));
}

/**
 * Downmixes planar channel data to one channel according to the mode.
 * Mixing averages all channels; picking modes return a copy of the kept
 * channel. Channels are assumed to share one length (the first
 * channel's length is used).
 * @param channels - Per-channel samples (at least one channel)
 * @param mode - Channel mode (must be a mono mode)
 * @returns Mono samples
 * @throws Error when called with the source pass-through mode or
 * without channel data, which would silently produce wrong audio
 */
export function downmixChannelData(
	channels: Float32Array[],
	mode: ChannelMode,
): Float32Array {
	const first = channels[0];
	if (!isMonoChannelMode(mode) || !first) {
		throw new Error('downmixChannelData requires a mono mode and data');
	}
	const pick = monoPickIndex(mode, channels.length);
	if (pick !== null) {
		// The index is clamped into range, so the channel exists
		return Float32Array.from(channels[pick] ?? first);
	}
	const length = first.length;
	const mixed = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < channels.length; channel++) {
			sum += channels[channel]?.[i] ?? 0;
		}
		mixed[i] = sum / channels.length;
	}
	return mixed;
}

/**
 * Downmixes a decoded AudioBuffer to mono according to the mode.
 * Returns the input buffer unchanged when the mode is pass-through or
 * the buffer is already mono, so callers can apply it unconditionally.
 * @param buffer - Decoded audio
 * @param mode - Channel mode
 * @returns Mono AudioBuffer, or the input buffer when nothing changes
 */
export function downmixAudioBuffer(
	buffer: AudioBuffer,
	mode: ChannelMode,
): AudioBuffer {
	if (!isMonoChannelMode(mode) || buffer.numberOfChannels <= 1) {
		return buffer;
	}
	const channels: Float32Array[] = [];
	for (let i = 0; i < buffer.numberOfChannels; i++) {
		channels.push(buffer.getChannelData(i));
	}
	const mono = new AudioBuffer({
		length: buffer.length,
		numberOfChannels: 1,
		sampleRate: buffer.sampleRate,
	});
	mono.getChannelData(0).set(downmixChannelData(channels, mode));
	return mono;
}
