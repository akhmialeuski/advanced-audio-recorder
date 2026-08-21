/**
 * Tests for the advanced two-pass bias helpers: the length safeguard (which
 * must reject a ratio outside the settings range so a synced or hand-edited
 * value cannot weaken the over-correction guard) and the capability-gated
 * "will the second pass run" predicate the cost surfaces read.
 * @module tests/unit/advancedBias.test
 */

import {
	advancedBiasUnsupportedReason,
	advancedTwoPassWillRun,
	meetsLengthSafeguard,
} from 'src/transcription/advanced/advancedBias';
import {
	DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO,
	MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
	TRANSCRIPTION_PROVIDER_IDS,
} from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** A 100-character baseline the safeguard tests compare a pass length against. */
const BASELINE = 'x'.repeat(100);

describe('meetsLengthSafeguard', () => {
	it('adopts a pass at or above the configured ratio', () => {
		expect(meetsLengthSafeguard(BASELINE, 'x'.repeat(60), 0.6)).toBe(true);
		expect(meetsLengthSafeguard(BASELINE, 'x'.repeat(59), 0.6)).toBe(false);
	});

	it('falls back to the default ratio below the configured minimum', () => {
		// The UI minimum is 0.5; a synced value under it (or 0, which would let
		// an empty second pass through) must not weaken the guard below default.
		const eightyPercent = 'x'.repeat(80);
		const seventyPercent = 'x'.repeat(70);
		expect(DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO).toBe(0.8);
		expect(MIN_ADVANCED_SECOND_PASS_MIN_RATIO).toBe(0.5);
		// Ratio 0 clamps to 0.8: a 70% pass is rejected, an 80% pass adopted.
		expect(meetsLengthSafeguard(BASELINE, seventyPercent, 0)).toBe(false);
		expect(meetsLengthSafeguard(BASELINE, eightyPercent, 0)).toBe(true);
		// An empty second pass never survives the clamped guard.
		expect(meetsLengthSafeguard(BASELINE, '', 0)).toBe(false);
		// A ratio between 0 and the minimum clamps the same way.
		expect(meetsLengthSafeguard(BASELINE, seventyPercent, 0.3)).toBe(false);
	});

	it('falls back to the default ratio above the maximum or for a non-finite value', () => {
		const seventyPercent = 'x'.repeat(70);
		expect(meetsLengthSafeguard(BASELINE, seventyPercent, 1.5)).toBe(false);
		expect(meetsLengthSafeguard(BASELINE, seventyPercent, Number.NaN)).toBe(
			false,
		);
	});
});

describe('advancedTwoPassWillRun', () => {
	function settings(
		overrides: Partial<AudioRecorderSettings>,
	): Pick<
		AudioRecorderSettings,
		| 'transcriptionAdvancedSettingsEnabled'
		| 'transcriptionAdvancedEnabled'
		| 'transcriptionProvider'
		| 'deepgramModel'
	> {
		return {
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			deepgramModel: 'nova-3',
			...overrides,
		};
	}

	it('runs when both switches are on and the engine can bias', () => {
		expect(advancedTwoPassWillRun(settings({}))).toBe(true);
		expect(
			advancedTwoPassWillRun(
				settings({
					transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
					deepgramModel: 'nova-3',
				}),
			),
		).toBe(true);
	});

	it('does not run when either switch is off', () => {
		expect(
			advancedTwoPassWillRun(
				settings({ transcriptionAdvancedSettingsEnabled: false }),
			),
		).toBe(false);
		expect(
			advancedTwoPassWillRun(
				settings({ transcriptionAdvancedEnabled: false }),
			),
		).toBe(false);
	});

	it('does not run on a Deepgram model that cannot bias', () => {
		// A hosted Whisper model on Deepgram accepts no biasing, so the service
		// degrades to one pass; the cost surfaces must agree and price one pass.
		expect(
			advancedTwoPassWillRun(
				settings({
					transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
					deepgramModel: 'whisper',
				}),
			),
		).toBe(false);
	});
});

describe('advancedBiasUnsupportedReason', () => {
	// Every engine gets a row: adding one without deciding whether it can
	// carry a bias is how an engine ends up silently degraded to one pass.
	it.each(
		Object.values(TRANSCRIPTION_PROVIDER_IDS).map((engineId) => ({
			engineId,
		})),
	)('lets $engineId bias on a model that can', ({ engineId }) => {
		expect(advancedBiasUnsupportedReason(engineId, 'nova-3')).toBeNull();
	});

	it('names the Deepgram model that cannot carry one', () => {
		const reason = advancedBiasUnsupportedReason(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'whisper-large',
		);

		expect(reason).toContain('whisper-large');
		expect(reason).toMatch(/cannot bias recognition/);
	});

	// The Deepgram model is consulted for Deepgram alone: an engine with no
	// per-model rule must not inherit whichever model the settings happen to
	// hold from a previous engine.
	it('ignores the Deepgram model for every other engine', () => {
		expect(
			advancedBiasUnsupportedReason(
				TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				'whisper-large',
			),
		).toBeNull();
	});
});
