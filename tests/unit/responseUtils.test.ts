/**
 * Tests for the narrowing helpers every provider response mapper parses
 * untrusted JSON through.
 *
 * They are two lines each, and they are shared by four mappers on purpose:
 * the module exists so that a change to the narrowing - dropping the array
 * exclusion, say - lands in one place. This suite is what makes such a change
 * visible instead of silently reshaping four transcripts.
 */

import { isRecord, num } from 'src/transcription/providers/responseUtils';

describe('isRecord', () => {
	it.each([
		{ name: 'a plain object', value: { a: 1 } },
		{ name: 'an empty object', value: {} },
		{ name: 'an object with a null prototype', value: Object.create(null) },
	])('accepts $name', ({ value }) => {
		expect(isRecord(value)).toBe(true);
	});

	it.each([
		{ name: 'null', value: null },
		{ name: 'undefined', value: undefined },
		{ name: 'a string', value: 'hello' },
		{ name: 'a number', value: 1 },
		{ name: 'a boolean', value: true },
	])('rejects $name', ({ value }) => {
		expect(isRecord(value)).toBe(false);
	});

	// Arrays are objects to `typeof`, and every mapper indexes `[0]` only
	// after its own Array.isArray check; letting an array through here would
	// make `body.results.channels[0]` reachable on a body that is a list.
	it.each([
		{ name: 'an empty array', value: [] },
		{ name: 'a populated array', value: [{ a: 1 }] },
	])('rejects $name, which typeof calls an object', ({ value }) => {
		expect(isRecord(value)).toBe(false);
	});
});

describe('num', () => {
	it.each([
		{ name: 'a positive number', value: 1.5, expected: 1.5 },
		{ name: 'zero', value: 0, expected: 0 },
		{ name: 'a negative number', value: -2, expected: -2 },
	])('returns $name unchanged', ({ value, expected }) => {
		expect(num(value)).toBe(expected);
	});

	it.each([
		{ name: 'undefined', value: undefined },
		{ name: 'null', value: null },
		{ name: 'a numeric string', value: '1.5' },
		{ name: 'NaN', value: Number.NaN },
		{ name: 'Infinity', value: Number.POSITIVE_INFINITY },
		{ name: '-Infinity', value: Number.NEGATIVE_INFINITY },
	])('falls back to zero for $name', ({ value }) => {
		expect(num(value)).toBe(0);
	});

	it('uses the caller-supplied fallback instead of zero', () => {
		expect(num('not a number', 7)).toBe(7);
	});

	// The fallback is what makes `end: num(entry.end, num(entry.start))`
	// collapse a segment onto its own start rather than onto the timeline's.
	it('prefers a usable value over the fallback', () => {
		expect(num(3, 7)).toBe(3);
	});
});
