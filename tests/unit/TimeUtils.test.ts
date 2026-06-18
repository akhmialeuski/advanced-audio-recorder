/**
 * Tests for time formatting and timecode parsing helpers.
 */

import { formatTimecode, parseTimecode } from 'src/utils/TimeUtils';

describe('formatTimecode', () => {
	it('formats sub-minute durations as m:ss', () => {
		expect(formatTimecode(0)).toBe('0:00');
		expect(formatTimecode(5)).toBe('0:05');
		expect(formatTimecode(65)).toBe('1:05');
	});

	it('formats hour-and-over durations as h:mm:ss', () => {
		expect(formatTimecode(3600)).toBe('1:00:00');
		expect(formatTimecode(3723)).toBe('1:02:03');
	});

	it('floors fractional seconds', () => {
		expect(formatTimecode(9.9)).toBe('0:09');
	});

	it('collapses invalid input to 0:00', () => {
		expect(formatTimecode(-5)).toBe('0:00');
		expect(formatTimecode(Number.NaN)).toBe('0:00');
		expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('0:00');
	});
});

describe('parseTimecode', () => {
	it('parses a plain seconds count', () => {
		expect(parseTimecode('90')).toBe(90);
		expect(parseTimecode('90.5')).toBe(90.5);
	});

	it('parses m:ss', () => {
		expect(parseTimecode('1:30')).toBe(90);
		expect(parseTimecode('0:05')).toBe(5);
	});

	it('parses h:mm:ss', () => {
		expect(parseTimecode('1:02:03')).toBe(3723);
	});

	it('parses a fractional final segment', () => {
		expect(parseTimecode('1:30.5')).toBe(90.5);
	});

	it('ignores surrounding whitespace', () => {
		expect(parseTimecode('  1:30 ')).toBe(90);
	});

	it('returns null for empty or malformed input', () => {
		expect(parseTimecode('')).toBeNull();
		expect(parseTimecode('   ')).toBeNull();
		expect(parseTimecode('abc')).toBeNull();
		expect(parseTimecode('1:2:3:4')).toBeNull();
		expect(parseTimecode('1:.5:3')).toBeNull();
	});
});

describe('formatTimecode / parseTimecode — more edge cases', () => {
	it('pads minutes only past an hour', () => {
		expect(formatTimecode(599)).toBe('9:59');
		expect(formatTimecode(3599)).toBe('59:59');
		expect(formatTimecode(3600)).toBe('1:00:00');
	});

	it('rejects empty segments and stray colons', () => {
		expect(parseTimecode(':30')).toBeNull();
		expect(parseTimecode('1:')).toBeNull();
		expect(parseTimecode('::')).toBeNull();
		expect(parseTimecode('1::3')).toBeNull();
	});

	it('rejects negative and non-numeric parts', () => {
		expect(parseTimecode('-5')).toBeNull();
		expect(parseTimecode('1:-5')).toBeNull();
		expect(parseTimecode('1a:30')).toBeNull();
	});

	it('allows a fractional component only in the last segment', () => {
		expect(parseTimecode('1.5')).toBe(1.5);
		expect(parseTimecode('0:0:1.25')).toBe(1.25);
		expect(parseTimecode('1.5:30')).toBeNull();
	});
});
