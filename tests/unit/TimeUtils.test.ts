/**
 * Tests for time formatting and timecode parsing helpers.
 * @module tests/unit/TimeUtils.test
 */

import {
	delay,
	formatTimecode,
	parseTimecode,
	scaledTimeoutMs,
} from 'src/utils/TimeUtils';

describe('formatTimecode', () => {
	it.each([
		{ name: 'zero', seconds: 0, expected: '0:00' },
		{ name: 'a single second', seconds: 1, expected: '0:01' },
		{ name: 'under a minute', seconds: 5, expected: '0:05' },
		{ name: 'exactly a minute', seconds: 60, expected: '1:00' },
		{ name: 'a minute and change', seconds: 65, expected: '1:05' },
		{
			name: 'the last second below ten minutes',
			seconds: 599,
			expected: '9:59',
		},
		{
			name: 'the last second below an hour',
			seconds: 3599,
			expected: '59:59',
		},
		{ name: 'exactly an hour', seconds: 3600, expected: '1:00:00' },
		{ name: 'over an hour', seconds: 3723, expected: '1:02:03' },
		{ name: 'over a day', seconds: 90061, expected: '25:01:01' },
	])('formats $name as $expected', ({ seconds, expected }) => {
		expect(formatTimecode(seconds)).toBe(expected);
	});

	it('floors fractional seconds rather than rounding them', () => {
		// Rounding up would show a timecode the audio has not reached yet.
		expect(formatTimecode(9.9)).toBe('0:09');
		expect(formatTimecode(59.999)).toBe('0:59');
	});

	it.each([
		{ name: 'a negative duration', seconds: -5 },
		{ name: 'not a number', seconds: Number.NaN },
		{ name: 'positive infinity', seconds: Number.POSITIVE_INFINITY },
		{ name: 'negative infinity', seconds: Number.NEGATIVE_INFINITY },
	])('collapses $name to 0:00', ({ seconds }) => {
		expect(formatTimecode(seconds)).toBe('0:00');
	});
});

describe('formatTimecode with a reference duration', () => {
	it.each([
		// Reference 1:07:20 - every marker time aligns at h:mm:ss so a list of
		// them lines up in the same columns.
		{
			name: 'under a minute',
			seconds: 109,
			total: 4040,
			expected: '0:01:49',
		},
		{
			name: 'under an hour',
			seconds: 1017,
			total: 4040,
			expected: '0:16:57',
		},
		{
			name: 'over an hour',
			seconds: 4028,
			total: 4040,
			expected: '1:07:08',
		},
		// Reference 12:23 - the shorter width for the whole list.
		{ name: 'a few seconds', seconds: 5, total: 743, expected: '0:05' },
		{
			name: 'a couple of minutes',
			seconds: 125,
			total: 743,
			expected: '2:05',
		},
		{
			name: 'the full length',
			seconds: 743,
			total: 743,
			expected: '12:23',
		},
	])(
		'renders $name at the reference width ($expected)',
		({ seconds, total, expected }) => {
			expect(formatTimecode(seconds, total)).toBe(expected);
		},
	);

	it.each([
		{ name: 'an hour-long reference', total: 4040, expected: '0:00:00' },
		{ name: 'a short reference', total: 600, expected: '0:00' },
	])(
		'collapses invalid input to $expected for $name',
		({ total, expected }) => {
			expect(formatTimecode(Number.NaN, total)).toBe(expected);
			expect(formatTimecode(-1, total)).toBe(expected);
		},
	);

	it('still shows hours when the value exceeds an hour despite a short reference', () => {
		// Defensive: a value past an hour never loses its hours component
		expect(formatTimecode(3661, 100)).toBe('1:01:01');
	});

	it.each([
		{
			name: 'not a number',
			total: Number.NaN,
			seconds: 65,
			expected: '1:05',
		},
		{
			name: 'infinite',
			total: Number.POSITIVE_INFINITY,
			seconds: 3661,
			expected: '1:01:01',
		},
	])(
		'falls back to value-based formatting when the reference is $name',
		({ seconds, total, expected }) => {
			expect(formatTimecode(seconds, total)).toBe(expected);
		},
	);
});

describe('parseTimecode', () => {
	it.each([
		{ name: 'a plain seconds count', input: '90', expected: 90 },
		{ name: 'fractional seconds', input: '90.5', expected: 90.5 },
		{ name: 'm:ss', input: '1:30', expected: 90 },
		{ name: 'a zero minute', input: '0:05', expected: 5 },
		{ name: 'h:mm:ss', input: '1:02:03', expected: 3723 },
		{ name: 'a fractional final segment', input: '1:30.5', expected: 90.5 },
		{ name: 'surrounding whitespace', input: '  1:30 ', expected: 90 },
		{ name: 'a bare fraction', input: '1.5', expected: 1.5 },
		{
			name: 'a fraction in the last of three segments',
			input: '0:0:1.25',
			expected: 1.25,
		},
		{ name: 'zero', input: '0', expected: 0 },
	])('parses $name as $expected', ({ input, expected }) => {
		expect(parseTimecode(input)).toBe(expected);
	});

	it.each([
		{ name: 'an empty string', input: '' },
		{ name: 'only whitespace', input: '   ' },
		{ name: 'letters', input: 'abc' },
		{ name: 'four segments', input: '1:2:3:4' },
		{ name: 'a fraction in a middle segment', input: '1:.5:3' },
		{ name: 'a fraction in a leading segment', input: '1.5:30' },
		{ name: 'a leading colon', input: ':30' },
		{ name: 'a trailing colon', input: '1:' },
		{ name: 'nothing but colons', input: '::' },
		{ name: 'an empty middle segment', input: '1::3' },
		{ name: 'a negative value', input: '-5' },
		{ name: 'a negative segment', input: '1:-5' },
		{ name: 'a segment with a stray letter', input: '1a:30' },
	])('returns null for $name', ({ input }) => {
		expect(parseTimecode(input)).toBeNull();
	});
});

describe('formatTimecode and parseTimecode round-trip', () => {
	it.each([0, 5, 59, 60, 599, 3599, 3600, 3723, 90061])(
		'parses back what it formatted for %i seconds',
		(seconds) => {
			expect(parseTimecode(formatTimecode(seconds))).toBe(seconds);
		},
	);
});

describe('delay', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('resolves once the delay has elapsed', async () => {
		const settled = jest.fn();
		const waiting = delay(500).then(settled);

		await jest.advanceTimersByTimeAsync(499);
		expect(settled).not.toHaveBeenCalled();

		await jest.advanceTimersByTimeAsync(1);
		await waiting;
		expect(settled).toHaveBeenCalled();
	});

	it('resolves on the next turn for a zero delay', async () => {
		const settled = jest.fn();
		const waiting = delay(0).then(settled);

		await jest.advanceTimersByTimeAsync(0);
		await waiting;

		expect(settled).toHaveBeenCalled();
	});

	it('rejects with the abort reason when the signal fires during the wait', async () => {
		const controller = new AbortController();
		const reason = new Error('cancelled by the user');
		const waiting = delay(500, controller.signal);

		await jest.advanceTimersByTimeAsync(100);
		controller.abort(reason);

		await expect(waiting).rejects.toBe(reason);
	});

	// A caller that aborted before it ever waited must not sit out the delay.
	it('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		const reason = new Error('already cancelled');
		controller.abort(reason);

		await expect(delay(500, controller.signal)).rejects.toBe(reason);
	});

	// The listener outliving the wait would pile one up per retry pause.
	it('stops listening to the signal once the delay has elapsed', async () => {
		const controller = new AbortController();
		const remove = jest.spyOn(controller.signal, 'removeEventListener');

		const waiting = delay(10, controller.signal);
		await jest.advanceTimersByTimeAsync(10);
		await waiting;

		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('resolves normally when a signal is given and never aborted', async () => {
		const controller = new AbortController();
		const settled = jest.fn();
		const waiting = delay(20, controller.signal).then(settled);

		await jest.advanceTimersByTimeAsync(20);
		await waiting;

		expect(settled).toHaveBeenCalledTimes(1);
	});
});

describe('scaledTimeoutMs', () => {
	const budget = { floorMs: 1000, bytesPerMs: 10, maxMs: 5000 };

	it('returns the floor for an empty payload', () => {
		expect(scaledTimeoutMs(0, budget)).toBe(1000);
	});

	it('adds time in proportion to the payload', () => {
		expect(scaledTimeoutMs(20000, budget)).toBe(3000);
	});

	it('rounds a partial millisecond of payload up', () => {
		expect(scaledTimeoutMs(1, budget)).toBe(1001);
	});

	it('caps the scaled budget at the maximum', () => {
		expect(scaledTimeoutMs(10_000_000, budget)).toBe(5000);
	});
});
