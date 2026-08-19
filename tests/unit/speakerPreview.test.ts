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
		// Both clamps, exactly on their boundary: a turn of precisely the
		// minimum or the maximum length is already playable and must come
		// back unchanged, or an off-by-one in either Math call would show up
		// as a preview a second short or a second long.
		{
			name: 'a turn of exactly the minimum length',
			overrides: {
				firstStart: 5,
				firstEnd: 5 + SPEAKER_PREVIEW_MIN_SECONDS,
			},
			expected: { start: 5, end: 5 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
		{
			name: 'a turn one tick under the minimum',
			overrides: {
				firstStart: 5,
				firstEnd: 5 + SPEAKER_PREVIEW_MIN_SECONDS - 0.001,
			},
			expected: { start: 5, end: 5 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
		{
			name: 'a turn of exactly the maximum length',
			overrides: {
				firstStart: 2,
				firstEnd: 2 + SPEAKER_PREVIEW_MAX_SECONDS,
			},
			expected: { start: 2, end: 2 + SPEAKER_PREVIEW_MAX_SECONDS },
		},
		{
			name: 'a turn one tick over the maximum',
			overrides: {
				firstStart: 2,
				firstEnd: 2 + SPEAKER_PREVIEW_MAX_SECONDS + 0.001,
			},
			expected: { start: 2, end: 2 + SPEAKER_PREVIEW_MAX_SECONDS },
		},
		// firstStart 0 is a real offset, not a missing one.
		{
			name: 'a turn at the very start of the recording',
			overrides: { firstStart: 0, firstEnd: 6 },
			expected: { start: 0, end: 6 },
		},
		// The parser never stores a negative offset, but the clamp keeps the
		// range playable for any entry handed in, and measures the turn from
		// the clamped start rather than from the impossible one.
		{
			name: 'a start before the recording began',
			overrides: { firstStart: -3, firstEnd: 10 },
			expected: { start: 0, end: 10 },
		},
		// firstEnd before firstStart is not a span; the minimum applies
		// rather than a range the player would seek past its own end.
		{
			name: 'a hand-edited end that precedes its start',
			overrides: { firstStart: 30, firstEnd: 5 },
			expected: { start: 30, end: 30 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
		{
			name: 'an end equal to its start',
			overrides: { firstStart: 30, firstEnd: 30 },
			expected: { start: 30, end: 30 + SPEAKER_PREVIEW_MIN_SECONDS },
		},
	])('excerpts $name into the playable bounds', ({ overrides, expected }) => {
		const range = speakerPreviewRange(entry(overrides));

		expect(range).toEqual(expected);
		// Whatever the input, the player is never handed a backwards range.
		expect(range?.end).toBeGreaterThan(range?.start ?? 0);
	});

	it('keeps the bounds sane relative to each other', () => {
		expect(SPEAKER_PREVIEW_MIN_SECONDS).toBeGreaterThan(0);
		expect(SPEAKER_PREVIEW_MAX_SECONDS).toBeGreaterThan(
			SPEAKER_PREVIEW_MIN_SECONDS,
		);
	});
});
