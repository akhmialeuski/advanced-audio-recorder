/**
 * Pure DSP helpers for the audio-cleanup chain: config resolution and
 * clamping, dB/gain conversion, the noise-gate open/close decision (with
 * hysteresis), and an offline envelope-based noise gate over decoded samples.
 * No WebAudio or I/O - all logic here is unit tested.
 *
 * The chain has two renderers. The offline one decodes a file and writes a
 * cleaned copy; the live one wires the same stages into a playback graph (see
 * module:player/LiveVoiceBoost). Both resolve what to apply here and both take
 * the gate decision from {@link gateShouldOpen}, so the two agree on how a
 * given configuration sounds rather than each carrying its own tuning.
 * @module cleanup/audioDsp
 */

import {
	CLEANUP_GATE_ATTACK_MS,
	CLEANUP_GATE_HYSTERESIS_DB,
	CLEANUP_GATE_RELEASE_MS,
	CLEANUP_GATE_WINDOW_SECONDS,
	DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
	DEFAULT_CLEANUP_HIGHPASS_HZ,
	DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
} from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { ChannelMode } from '../audio/downmix';

/** Resolved, clamped audio-cleanup configuration. */
export interface AudioDspConfig {
	highPass: { enabled: boolean; hz: number };
	gate: { enabled: boolean; thresholdDb: number };
	leveling: { enabled: boolean; makeupDb: number };
	/**
	 * Channel layout for the cleaned copy: keep the source layout or
	 * downmix to mono (mix or one picked channel). A per-run choice,
	 * not seeded from settings.
	 */
	channelMode: ChannelMode;
}

/**
 * The processing stages alone, without the downmix choice: what a live
 * playback chain renders. Derived from {@link AudioDspConfig} rather than
 * written out again, so a stage added there cannot go missing here.
 */
export type VoiceBoostStages = Omit<AudioDspConfig, 'channelMode'>;

/** Clamps a value into a range, falling back when non-finite. */
function clamp(
	value: number,
	min: number,
	max: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

/**
 * Resolves the three processing stages from settings, clamping every numeric
 * field into its supported range. Both renderers start here: the offline pass
 * adds the downmix choice on top, and a live playback chain has none, so the
 * stages are the whole of what it renders.
 * @param settings - Plugin settings
 */
export function resolveVoiceBoostStages(
	settings: AudioRecorderSettings,
): VoiceBoostStages {
	return {
		highPass: {
			enabled: settings.cleanupHighPassEnabled,
			hz: clamp(
				settings.cleanupHighPassHz,
				MIN_CLEANUP_HIGHPASS_HZ,
				MAX_CLEANUP_HIGHPASS_HZ,
				DEFAULT_CLEANUP_HIGHPASS_HZ,
			),
		},
		gate: {
			enabled: settings.cleanupNoiseGateEnabled,
			thresholdDb: clamp(
				settings.cleanupNoiseGateThresholdDb,
				MIN_CLEANUP_GATE_THRESHOLD_DB,
				MAX_CLEANUP_GATE_THRESHOLD_DB,
				DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
			),
		},
		leveling: {
			enabled: settings.cleanupLevelingEnabled,
			makeupDb: clamp(
				settings.cleanupLevelingMakeupDb,
				MIN_CLEANUP_LEVELING_MAKEUP_DB,
				MAX_CLEANUP_LEVELING_MAKEUP_DB,
				DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
			),
		},
	};
}

/**
 * Resolves the cleanup configuration from settings, clamping every
 * numeric field into its supported range. Used as the default config the
 * processing dialog starts from.
 * @param settings - Plugin settings
 */
export function resolveAudioDspConfig(
	settings: AudioRecorderSettings,
): AudioDspConfig {
	return {
		...resolveVoiceBoostStages(settings),
		channelMode: ChannelMode.Source,
	};
}

/**
 * True when at least one DSP stage is enabled (a filter, gate, or
 * leveling pass would change the audio). A mono downmix is a change too
 * but is tracked separately, since it depends on the source channel
 * count the config does not carry - see {@link hasActiveChange}.
 * @param config - Resolved config
 */
export function hasActiveStage(config: VoiceBoostStages): boolean {
	return (
		config.highPass.enabled ||
		config.gate.enabled ||
		config.leveling.enabled
	);
}

/**
 * True when processing would change the audio at all: any DSP stage, or
 * a mono channel mode (a downmix, or a channel pick, that alters the
 * output). Used by the dialog to allow a pure mono downmix with no DSP
 * stage enabled.
 * @param config - Resolved config
 */
export function hasActiveChange(config: AudioDspConfig): boolean {
	return hasActiveStage(config) || config.channelMode !== ChannelMode.Source;
}

/**
 * Whether two resolved stage sets are identical. A settings save that changed
 * none of them re-routes nothing on a chain that is already running, the same
 * way an unchanged player layout applies nothing to an open player.
 * @param a - One resolved stages
 * @param b - Another resolved stages
 * @returns True when every stage and every parameter matches
 */
export function voiceBoostStagesEqual(
	a: VoiceBoostStages,
	b: VoiceBoostStages,
): boolean {
	return (
		a.highPass.enabled === b.highPass.enabled &&
		a.highPass.hz === b.highPass.hz &&
		a.gate.enabled === b.gate.enabled &&
		a.gate.thresholdDb === b.gate.thresholdDb &&
		a.leveling.enabled === b.leveling.enabled &&
		a.leveling.makeupDb === b.leveling.makeupDb
	);
}

/**
 * Converts a dB value to a linear gain multiplier.
 * @param db - Level in decibels
 */
export function dbToGain(db: number): number {
	return Math.pow(10, db / 20);
}

/**
 * Noise-gate open/close decision with hysteresis: opens at the threshold
 * and only closes once the level falls a hysteresis margin below it, so
 * the gate does not chatter around the threshold.
 * @param rmsDb - Current level in dBFS
 * @param thresholdDb - Open threshold in dBFS
 * @param hysteresisDb - Margin below the threshold for closing
 * @param currentlyOpen - Whether the gate is currently open
 */
export function gateShouldOpen(
	rmsDb: number,
	thresholdDb: number,
	hysteresisDb: number,
	currentlyOpen: boolean,
): boolean {
	if (rmsDb >= thresholdDb) {
		return true;
	}
	if (rmsDb <= thresholdDb - hysteresisDb) {
		return false;
	}
	return currentlyOpen;
}

/**
 * Applies an envelope-based noise gate to one channel of samples,
 * returning a new array. The level is tracked per short window; the gain
 * ramps toward open/closed with attack/release smoothing so gating never
 * introduces clicks.
 * @param samples - Channel samples in the range -1..1
 * @param sampleRate - Sample rate in Hz
 * @param thresholdDb - Gate threshold in dBFS
 * @param attackMs - Open ramp time constant in milliseconds
 * @param releaseMs - Close ramp time constant in milliseconds
 * @returns New gated channel samples
 */
export function applyNoiseGateToChannel(
	samples: Float32Array,
	sampleRate: number,
	thresholdDb: number,
	attackMs = CLEANUP_GATE_ATTACK_MS,
	releaseMs = CLEANUP_GATE_RELEASE_MS,
): Float32Array {
	const out = new Float32Array(samples.length);
	if (samples.length === 0 || sampleRate <= 0) {
		return out;
	}
	const windowSize = Math.max(
		1,
		Math.floor(sampleRate * CLEANUP_GATE_WINDOW_SECONDS),
	);
	const attackCoef = Math.exp(-1 / (sampleRate * (attackMs / 1000)));
	const releaseCoef = Math.exp(-1 / (sampleRate * (releaseMs / 1000)));
	let open = true;
	let gain = 1;

	for (let start = 0; start < samples.length; start += windowSize) {
		const end = Math.min(samples.length, start + windowSize);
		let sumSquares = 0;
		for (let i = start; i < end; i++) {
			const sample = samples[i] ?? 0;
			sumSquares += sample * sample;
		}
		const rms = Math.sqrt(sumSquares / (end - start));
		const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		open = gateShouldOpen(
			rmsDb,
			thresholdDb,
			CLEANUP_GATE_HYSTERESIS_DB,
			open,
		);
		const target = open ? 1 : 0;
		for (let i = start; i < end; i++) {
			const coef = target > gain ? attackCoef : releaseCoef;
			gain = target + (gain - target) * coef;
			out[i] = (samples[i] ?? 0) * gain;
		}
	}
	return out;
}
