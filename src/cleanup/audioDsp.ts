/**
 * Pure DSP helpers for on-demand audio cleanup: config resolution and
 * clamping, dB/gain conversion, the noise-gate open/close decision (with
 * hysteresis), and an offline envelope-based noise gate over decoded
 * samples. No WebAudio or I/O - all logic here is unit tested.
 * @module cleanup/audioDsp
 */

import {
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
import type { AudioRecorderSettings } from '../settings/Settings';

/** Resolved, clamped audio-cleanup configuration. */
export interface AudioDspConfig {
	highPass: { enabled: boolean; hz: number };
	gate: { enabled: boolean; thresholdDb: number };
	leveling: { enabled: boolean; makeupDb: number };
}

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
 * Resolves the cleanup configuration from settings, clamping every
 * numeric field into its supported range. Used as the default config the
 * processing dialog starts from.
 * @param settings - Plugin settings
 */
export function resolveAudioDspConfig(
	settings: AudioRecorderSettings,
): AudioDspConfig {
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
 * True when at least one stage is enabled (processing would change the
 * audio).
 * @param config - Resolved config
 */
export function hasActiveStage(config: AudioDspConfig): boolean {
	return (
		config.highPass.enabled ||
		config.gate.enabled ||
		config.leveling.enabled
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

/** Window size, in seconds, used to track the gate envelope. */
const GATE_WINDOW_SECONDS = 0.02;

/** Hysteresis, in dB, for the offline gate. */
const GATE_HYSTERESIS_DB = 6;

/** Gate open ramp time constant in milliseconds (fast, to avoid clipping onsets). */
const GATE_ATTACK_MS = 5;

/** Gate close ramp time constant in milliseconds (slower, to avoid clicks). */
const GATE_RELEASE_MS = 80;

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
	attackMs = GATE_ATTACK_MS,
	releaseMs = GATE_RELEASE_MS,
): Float32Array {
	const out = new Float32Array(samples.length);
	if (samples.length === 0 || sampleRate <= 0) {
		return out;
	}
	const windowSize = Math.max(
		1,
		Math.floor(sampleRate * GATE_WINDOW_SECONDS),
	);
	const attackCoef = Math.exp(-1 / (sampleRate * (attackMs / 1000)));
	const releaseCoef = Math.exp(-1 / (sampleRate * (releaseMs / 1000)));
	let open = true;
	let gain = 1;

	for (let start = 0; start < samples.length; start += windowSize) {
		const end = Math.min(samples.length, start + windowSize);
		let sumSquares = 0;
		for (let i = start; i < end; i++) {
			sumSquares += samples[i] * samples[i];
		}
		const rms = Math.sqrt(sumSquares / (end - start));
		const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		open = gateShouldOpen(rmsDb, thresholdDb, GATE_HYSTERESIS_DB, open);
		const target = open ? 1 : 0;
		for (let i = start; i < end; i++) {
			const coef = target > gain ? attackCoef : releaseCoef;
			gain = target + (gain - target) * coef;
			out[i] = samples[i] * gain;
		}
	}
	return out;
}
