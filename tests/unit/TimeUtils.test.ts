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

describe('formatTimecode with a reference duration', () => {
	it('forces h:mm:ss for every value when the recording is an hour or more', () => {
		// Reference 1:07:20 -> all marker times align at h:mm:ss
		const total = 4040;
		expect(formatTimecode(109, total)).toBe('0:01:49');
		expect(formatTimecode(1017, total)).toBe('0:16:57');
		expect(formatTimecode(4028, total)).toBe('1:07:08');
	});

	it('keeps m:ss for every value when the recording is under an hour', () => {
		const total = 743; // 12:23
		expect(formatTimecode(5, total)).toBe('0:05');
		expect(formatTimecode(125, total)).toBe('2:05');
		expect(formatTimecode(743, total)).toBe('12:23');
	});

	it('collapses invalid input to the reference width', () => {
		expect(formatTimecode(Number.NaN, 4040)).toBe('0:00:00');
		expect(formatTimecode(-1, 4040)).toBe('0:00:00');
		expect(formatTimecode(Number.NaN, 600)).toBe('0:00');
	});

	it('still shows hours when the value exceeds an hour despite a short reference', () => {
		// Defensive: a value past an hour never loses its hours component
		expect(formatTimecode(3661, 100)).toBe('1:01:01');
	});

	it('falls back to value-based formatting when the reference is not finite', () => {
		expect(formatTimecode(65, Number.NaN)).toBe('1:05');
		expect(formatTimecode(3661, Number.POSITIVE_INFINITY)).toBe('1:01:01');
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

describe('formatTimecode / parseTimecode - more edge cases', () => {
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
