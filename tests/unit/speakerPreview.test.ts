/**
 * Tests for the excerpt the rename dialog plays per speaker: which entries can
 * be previewed at all, and how a first turn is clamped into something long
 * enough to recognize and short enough to sit through.
 */

import type { SpeakerEntry } from 'src/sidecar/recordingSidecarModel';
import {
	SPEAKER_PREVIEW_MAX_SECONDS,
	SPEAKER_PREVIEW_MIN_SECONDS,
	speakerPreviewRange,
} from 'src/speakers/speakerPreview';

/** A roster entry with the given first-turn offsets. */
function entry(overrides: Partial<SpeakerEntry> = {}): SpeakerEntry {
	return { label: 'Speaker 1', ...overrides };
}

describe('speakerPreviewRange', () => {
	it('is unavailable for a roster written before offsets were stored', () => {
		// The dialog disables the button on null rather than playing from 0,
		// which would be some other speaker's audio.
		expect(speakerPreviewRange(entry())).toBeNull();
		expect(speakerPreviewRange(entry({ name: 'Alex' }))).toBeNull();
		// An end without a start locates nothing either.
		expect(speakerPreviewRange(entry({ firstEnd: 30 }))).toBeNull();
	});

	it('plays the whole first turn when it falls inside the bounds', () => {
		expect(
			speakerPreviewRange(entry({ firstStart: 12, firstEnd: 20 })),
		).toEqual({ start: 12, end: 20 });
	});

	it('extends a turn shorter than the minimum into what follows it', () => {
		// A one-word "Yeah" identifies nobody, so the excerpt runs on into the
		// audio after it.
		expect(
			speakerPreviewRange(entry({ firstStart: 5, firstEnd: 5.4 })),
		).toEqual({ start: 5, end: 5 + SPEAKER_PREVIEW_MIN_SECONDS });
	});

	it('cuts an opening monologue off at the maximum', () => {
		expect(
			speakerPreviewRange(entry({ firstStart: 0, firstEnd: 600 })),
		).toEqual({ start: 0, end: SPEAKER_PREVIEW_MAX_SECONDS });
	});

	it('uses the minimum when only the start is stored', () => {
		expect(speakerPreviewRange(entry({ firstStart: 8 }))).toEqual({
			start: 8,
			end: 8 + SPEAKER_PREVIEW_MIN_SECONDS,
		});
	});

	it('clamps a negative start to the beginning of the recording', () => {
		// The parser never stores a negative offset, but the clamp keeps the
		// range playable for any entry handed in, and measures the turn from
		// the clamped start rather than from the impossible one.
		expect(
			speakerPreviewRange(entry({ firstStart: -3, firstEnd: 10 })),
		).toEqual({ start: 0, end: 10 });
	});

	it('never produces a backwards range from a hand-edited sidecar', () => {
		// firstEnd before firstStart is not a span; the minimum applies rather
		// than a range the player would seek past its own end.
		const range = speakerPreviewRange(
			entry({ firstStart: 30, firstEnd: 5 }),
		);
		expect(range).toEqual({
			start: 30,
			end: 30 + SPEAKER_PREVIEW_MIN_SECONDS,
		});
		expect(range?.end).toBeGreaterThan(range?.start ?? 0);
	});

	it('is available at the very start of a recording', () => {
		// firstStart 0 is a real offset, not a missing one.
		expect(
			speakerPreviewRange(entry({ firstStart: 0, firstEnd: 6 })),
		).toEqual({ start: 0, end: 6 });
	});

	it('keeps the bounds sane relative to each other', () => {
		expect(SPEAKER_PREVIEW_MIN_SECONDS).toBeGreaterThan(0);
		expect(SPEAKER_PREVIEW_MAX_SECONDS).toBeGreaterThan(
			SPEAKER_PREVIEW_MIN_SECONDS,
		);
	});
});
