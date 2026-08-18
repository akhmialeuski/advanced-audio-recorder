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
	it.each([
		{ name: 'nothing at all', overrides: {} },
		{ name: 'only a name', overrides: { name: 'Alex' } },
		{ name: 'an end with no start', overrides: { firstEnd: 30 } },
	])('offers no excerpt for a roster entry with $name', ({ overrides }) => {
		// The dialog disables the button on null rather than playing from 0,
		// which would be some other speaker's audio.
		expect(speakerPreviewRange(entry(overrides))).toBeNull();
	});

	it.each([
		{
			name: 'a turn that already fits',
			overrides: { firstStart: 12, firstEnd: 20 },
			expected: { start: 12, end: 20 },
		},
		{
			name: 'a one-word turn, which identifies nobody',
			overrides: { firstStart: 5, firstEnd: 5.4 },
			expected: { start: 5, end: 5 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
		{
			name: 'an opening monologue',
			overrides: { firstStart: 0, firstEnd: 600 },
			expected: { start: 0, end: SPEAKER_PREVIEW_MAX_SECONDS },
		},
		{
			name: 'a start with no end stored',
			overrides: { firstStart: 8 },
			expected: { start: 8, end: 8 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
	])('excerpts $name into the playable bounds', ({ overrides, expected }) => {
		expect(speakerPreviewRange(entry(overrides))).toEqual(expected);
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
