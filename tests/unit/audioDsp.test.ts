/**
 * Tests for the pure input-DSP helpers: gate decision (with hysteresis),
 * dB-to-gain, config resolution/clamping, and active-stage detection.
 */

import {
	applyNoiseGateToChannel,
	dbToGain,
	gateShouldOpen,
	hasActiveStage,
	resolveAudioDspConfig,
} from 'src/cleanup/audioDsp';
import { mergeSettings } from 'src/settings/Settings';
import {
	DEFAULT_INPUT_HIGHPASS_HZ,
	MAX_INPUT_GATE_THRESHOLD_DB,
	MAX_INPUT_HIGHPASS_HZ,
	MIN_INPUT_LEVELING_MAKEUP_DB,
} from 'src/constants';

describe('gateShouldOpen', () => {
	it('opens at or above the threshold', () => {
		expect(gateShouldOpen(-40, -50, 6, false)).toBe(true);
		expect(gateShouldOpen(-50, -50, 6, false)).toBe(true);
	});

	it('closes only below the hysteresis margin', () => {
		// Between (threshold - hysteresis) and threshold: keep state
		expect(gateShouldOpen(-54, -50, 6, true)).toBe(true);
		expect(gateShouldOpen(-54, -50, 6, false)).toBe(false);
		// Below the margin: always closed
		expect(gateShouldOpen(-57, -50, 6, true)).toBe(false);
	});
});

describe('dbToGain', () => {
	it('maps 0 dB to 1 and +6 dB to ~2', () => {
		expect(dbToGain(0)).toBeCloseTo(1);
		expect(dbToGain(6)).toBeCloseTo(1.995, 2);
		expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
	});
});

describe('hasActiveStage', () => {
	it('is false only when every stage is disabled', () => {
		const off = {
			highPass: { enabled: false, hz: 80 },
			gate: { enabled: false, thresholdDb: -50 },
			leveling: { enabled: false, makeupDb: 6 },
		};
		expect(hasActiveStage(off)).toBe(false);
		expect(
			hasActiveStage({
				...off,
				gate: { enabled: true, thresholdDb: -50 },
			}),
		).toBe(true);
	});
});

describe('resolveAudioDspConfig', () => {
	it('passes through valid values', () => {
		const config = resolveAudioDspConfig(
			mergeSettings({
				inputHighPassEnabled: true,
				inputHighPassHz: 120,
				inputNoiseGateEnabled: true,
				inputNoiseGateThresholdDb: -45,
				inputLevelingEnabled: true,
				inputLevelingMakeupDb: 9,
			}),
		);
		expect(config.highPass).toEqual({ enabled: true, hz: 120 });
		expect(config.gate).toEqual({ enabled: true, thresholdDb: -45 });
		expect(config.leveling).toEqual({ enabled: true, makeupDb: 9 });
	});

	it('clamps out-of-range values', () => {
		const config = resolveAudioDspConfig(
			mergeSettings({
				inputHighPassHz: 10_000,
				inputNoiseGateThresholdDb: 0,
				inputLevelingMakeupDb: -100,
			}),
		);
		expect(config.highPass.hz).toBe(MAX_INPUT_HIGHPASS_HZ);
		expect(config.gate.thresholdDb).toBe(MAX_INPUT_GATE_THRESHOLD_DB);
		expect(config.leveling.makeupDb).toBe(MIN_INPUT_LEVELING_MAKEUP_DB);
	});

	it('falls back to defaults for non-finite values', () => {
		const settings = mergeSettings({});
		settings.inputHighPassHz = Number.NaN;
		expect(resolveAudioDspConfig(settings).highPass.hz).toBe(
			DEFAULT_INPUT_HIGHPASS_HZ,
		);
	});
});

describe('applyNoiseGateToChannel', () => {
	it('passes loud audio and attenuates quiet audio', () => {
		const sampleRate = 16000;
		const samples = new Float32Array(sampleRate); // 1 second
		// First half loud (0.5 ~ -6 dBFS), second half near-silent (~-80 dBFS)
		for (let i = 0; i < samples.length; i++) {
			const loud = i < samples.length / 2;
			samples[i] = (loud ? 0.5 : 0.0001) * (i % 2 === 0 ? 1 : -1);
		}
		const gated = applyNoiseGateToChannel(samples, sampleRate, -40);

		// Mid-point of the loud region is essentially unchanged
		const loudIndex = Math.floor(samples.length / 4);
		expect(Math.abs(gated[loudIndex])).toBeGreaterThan(0.45);
		// End of the silent region is gated to near zero
		const lastSample = gated[gated.length - 1];
		expect(Math.abs(lastSample)).toBeLessThan(0.00005);
	});

	it('returns an empty array for empty input', () => {
		expect(
			applyNoiseGateToChannel(new Float32Array(0), 16000, -40),
		).toEqual(new Float32Array(0));
	});
});
