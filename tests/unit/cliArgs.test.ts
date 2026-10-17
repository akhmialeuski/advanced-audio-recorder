/**
 * Tests for reading what was typed after a command on the Obsidian command
 * line: a `name=value` parameter, a bare-word flag, and the values each kind
 * of parameter accepts - or the sentence the command answers with instead.
 * @module tests/unit/cliArgs.test
 */

import {
	choiceParam,
	cliChoice,
	cliFlag,
	cliNumber,
	cliSwitch,
	cliText,
	cliTime,
	flagParam,
	valueParam,
} from 'src/obsidian/cliArgs';

describe('a value parameter', () => {
	it('reads the value, trimmed', () => {
		expect(cliText({ label: '  Intro  ' }, 'label')).toBe('Intro');
	});

	it.each([
		{ name: 'not typed', args: {} },
		// Obsidian passes a parameter typed without its value as the word true.
		{ name: 'typed without a value', args: { label: 'true' } },
		{ name: 'blank', args: { label: '   ' } },
	])('reads nothing when $name', ({ args }) => {
		expect(cliText(args, 'label')).toBeNull();
	});
});

describe('a bare-word flag', () => {
	it.each([
		{ name: 'typed bare', args: { all: 'true' }, on: true },
		{ name: 'typed with a value', args: { all: 'yes' }, on: true },
		{ name: 'not typed', args: {}, on: false },
		{ name: 'typed as off', args: { all: 'off' }, on: false },
		{ name: 'typed as false', args: { all: 'FALSE' }, on: false },
		{ name: 'typed as no', args: { all: ' no ' }, on: false },
		{ name: 'typed as 0', args: { all: '0' }, on: false },
	])('reads $on when $name', ({ args, on }) => {
		expect(cliFlag(args, 'all')).toBe(on);
	});
});

describe('a choice', () => {
	const formats = ['list', 'cue', 'outline'] as const;

	it('reads the value as the choices spell it', () => {
		expect(cliChoice({ format: 'CUE' }, 'format', formats)).toEqual({
			value: 'cue',
		});
	});

	it('reads nothing when not typed', () => {
		expect(cliChoice({}, 'format', formats)).toEqual({ value: null });
	});

	it('names every choice when the value is none of them', () => {
		expect(cliChoice({ format: 'pdf' }, 'format', formats)).toEqual({
			refusal: 'format=pdf is not one of: list, cue, outline.',
		});
	});
});

describe('a switch', () => {
	it.each([
		{ value: 'on', reads: true },
		{ value: 'YES', reads: true },
		{ value: '1', reads: true },
		{ value: 'true', reads: true },
		{ value: 'off', reads: false },
		{ value: 'no', reads: false },
		{ value: '0', reads: false },
	])('reads $value as $reads', ({ value, reads }) => {
		expect(cliSwitch({ diarize: value }, 'diarize')).toEqual({
			value: reads,
		});
	});

	it('reads nothing when not typed', () => {
		expect(cliSwitch({}, 'diarize')).toEqual({ value: null });
	});

	it('refuses a value that is neither', () => {
		expect(cliSwitch({ diarize: 'maybe' }, 'diarize')).toEqual({
			refusal: 'diarize=maybe is not on or off.',
		});
	});
});

describe('a number', () => {
	const minutes = { min: 1, max: 180, integer: true };

	it.each([
		{ value: '1', reads: 1 },
		{ value: '180', reads: 180 },
		{ value: ' 15 ', reads: 15 },
	])('reads $value within its range', ({ value, reads }) => {
		expect(cliNumber({ minutes: value }, 'minutes', minutes)).toEqual({
			value: reads,
		});
	});

	it('reads a fraction where fractions are accepted', () => {
		expect(cliNumber({ gain: '2.5' }, 'gain', { min: 0, max: 24 })).toEqual(
			{ value: 2.5 },
		);
	});

	it('reads a negative number where the range has them', () => {
		expect(
			cliNumber({ gate: '-50' }, 'gate', { min: -80, max: -20 }),
		).toEqual({ value: -50 });
	});

	it.each([
		{ name: 'below the range', value: '0' },
		{ name: 'above the range', value: '181' },
		{ name: 'a fraction', value: '1.5' },
		{ name: 'not a number', value: 'ten' },
		{ name: 'in exponent form', value: '1e2' },
	])('refuses a value $name', ({ value }) => {
		expect(cliNumber({ minutes: value }, 'minutes', minutes)).toEqual({
			refusal: `minutes=${value.trim()} is not a whole number from 1 to 180.`,
		});
	});

	it('names a plain number in the refusal where fractions are accepted', () => {
		expect(cliNumber({ gain: '30' }, 'gain', { min: 0, max: 24 })).toEqual({
			refusal: 'gain=30 is not a number from 0 to 24.',
		});
	});

	it('reads nothing when not typed', () => {
		expect(cliNumber({}, 'minutes', minutes)).toEqual({ value: null });
	});
});

describe('a time', () => {
	it.each([
		{ value: '90', seconds: 90 },
		{ value: '1:30', seconds: 90 },
		{ value: '1:01:30', seconds: 3690 },
	])('reads $value as $seconds seconds', ({ value, seconds }) => {
		expect(cliTime({ at: value }, 'at')).toEqual({ value: seconds });
	});

	it('reads nothing when not typed', () => {
		expect(cliTime({}, 'at')).toEqual({ value: null });
	});

	it('refuses what is not a time', () => {
		expect(cliTime({ at: 'noon' }, 'at')).toEqual({
			refusal: 'at=noon is not a time: use seconds, m:ss or h:mm:ss.',
		});
	});
});

describe('declaring parameters for the help output', () => {
	it('declares a value parameter with its placeholder', () => {
		expect(valueParam('<path>', 'The folder.')).toEqual({
			value: '<path>',
			description: 'The folder.',
		});
	});

	it('declares a flag without one', () => {
		expect(flagParam('Run on each.')).toEqual({
			description: 'Run on each.',
		});
	});

	it('declares a choice by its values', () => {
		expect(choiceParam(['md', 'json'], 'The format.')).toEqual({
			value: 'md|json',
			description: 'The format.',
		});
	});
});
