/**
 * Tests the joining of parts sent with the end of the part before them: whose
 * name a later part's speakers take, where the later part takes over, and
 * what happens when there is nothing to match against.
 * @module tests/unit/partSeams.test
 */

import { joinSeams, type SeamPart } from 'src/transcription/partSeams';
import { buildTranscript } from 'src/transcription/transcriptModel';

/** A line as a test states it: recording seconds, speaker, text. */
type Line = readonly [
	start: number,
	end: number,
	speaker: string,
	text: string,
];

/** Ten-minute parts, the later ones sent with thirty seconds before them. */
const PART_SECONDS = 600;
const LEAD_IN_SECONDS = 30;

/**
 * A transcribed part, from lines given in the recording's own seconds.
 * @param index - Zero-based position of the part
 * @param lines - Its lines, lead-in included
 * @param leadIn - Seconds of the part before it that it was sent with
 * @returns The part as a pass records it
 */
function part(
	index: number,
	lines: readonly Line[],
	leadIn = index === 0 ? 0 : LEAD_IN_SECONDS,
): SeamPart {
	const offsetSeconds = index * PART_SECONDS - leadIn;
	return {
		offsetSeconds,
		...(leadIn > 0 ? { leadInSeconds: leadIn } : {}),
		endSeconds: (index + 1) * PART_SECONDS,
		transcript: buildTranscript(
			lines.map(([start, end, speaker, text]) => ({
				start: start - offsetSeconds,
				end: end - offsetSeconds,
				speaker,
				text,
			})),
		),
	};
}

/**
 * The joined transcript as one list of "speaker: text" lines.
 * @param parts - The joined parts
 * @returns Every line, in timeline order
 */
function spoken(parts: readonly SeamPart[]): string[] {
	return parts.flatMap(({ transcript }) =>
		transcript.segments.map(
			(segment) => `${segment.speaker ?? '?'}: ${segment.text}`,
		),
	);
}

/** A first part that hears both names, ending in a line the seam cuts. */
const NAMED_FIRST = part(0, [
	[10, 20, 'Olga', 'Dzień dobry.'],
	[575, 585, 'Anatol', 'Rozumiem.'],
	[588, 600, 'Olga', 'A teraz przeczytamy'],
]);

describe('joinSeams', () => {
	it('gives a later part the names its speakers had in the part before', () => {
		const joined = joinSeams([
			NAMED_FIRST,
			part(1, [
				[575, 585, 'Speaker 2', 'Rozumiem.'],
				[588, 606, 'Speaker 1', 'A teraz przeczytamy tekst.'],
				[610, 620, 'Speaker 2', 'Dobrze.'],
			]),
		]);

		expect(spoken(joined)).toEqual([
			'Olga: Dzień dobry.',
			'Anatol: Rozumiem.',
			'Olga: A teraz przeczytamy tekst.',
			'Anatol: Dobrze.',
		]);
	});

	it('keeps the sentence the seam cut as the later part heard it, once', () => {
		const joined = joinSeams([
			NAMED_FIRST,
			part(1, [[588, 606, 'Speaker 1', 'A teraz przeczytamy tekst.']]),
		]);

		expect(
			spoken(joined).filter((line) => line.includes('przeczytamy')),
		).toEqual(['Olga: A teraz przeczytamy tekst.']);
	});

	it('keeps a sentence once when the later part split the cut line in two', () => {
		const joined = joinSeams([
			part(0, [
				[590.26, 592.26, 'Anatol', 'Aha.'],
				[
					592.26,
					601.26,
					'Olga',
					'Mhm, dobrze. Otwieram. Jestem młodym i...',
				],
			]),
			part(1, [
				[590.26, 592.26, 'Speaker 2', 'Aha.'],
				[592.5, 598.5, 'Speaker 1', 'Mhm, dobrze. Otwieram.'],
				[598.52, 604.52, 'Speaker 1', 'Jestem młodym i aktywnym.'],
			]),
		]);

		expect(spoken(joined)).toEqual([
			'Anatol: Aha.',
			'Olga: Mhm, dobrze. Otwieram.',
			'Olga: Jestem młodym i aktywnym.',
		]);
	});

	it('names the one speaker the shared stretch did not hold by elimination', () => {
		const joined = joinSeams([
			NAMED_FIRST,
			part(1, [
				[588, 606, 'Speaker 1', 'A teraz przeczytamy tekst.'],
				[610, 620, 'Speaker 2', 'Dobrze.'],
			]),
		]);

		expect(spoken(joined).at(-1)).toBe('Anatol: Dobrze.');
	});

	it('carries the names on through every later part', () => {
		const joined = joinSeams([
			NAMED_FIRST,
			part(1, [
				[575, 585, 'Speaker 2', 'Rozumiem.'],
				[588, 606, 'Speaker 1', 'A teraz przeczytamy tekst.'],
				[1175, 1195, 'Speaker 2', 'Skończyłem.'],
			]),
			part(2, [
				[1175, 1195, 'Speaker 1', 'Skończyłem.'],
				[1205, 1210, 'Speaker 2', 'Świetnie.'],
			]),
		]);

		expect(spoken(joined).slice(-2)).toEqual([
			'Anatol: Skończyłem.',
			'Olga: Świetnie.',
		]);
	});

	it('gives a new number to a speaker whose label a matched speaker took', () => {
		const joined = joinSeams([
			part(0, [
				[10, 20, 'Speaker 1', 'One.'],
				[30, 40, 'Speaker 2', 'Two.'],
				[50, 60, 'Speaker 3', 'Three.'],
				[575, 598, 'Speaker 1', 'Still one.'],
			]),
			part(1, [
				[575, 598, 'Speaker 2', 'Still one.'],
				[610, 620, 'Speaker 1', 'Somebody.'],
				[630, 640, 'Speaker 3', 'Three again.'],
			]),
		]);

		expect(spoken(joined).slice(-3)).toEqual([
			'Speaker 1: Still one.',
			'Speaker 4: Somebody.',
			'Speaker 3: Three again.',
		]);
	});

	it('leaves the labels alone when nobody spoke in the shared stretch', () => {
		const joined = joinSeams([
			part(0, [[10, 20, 'Olga', 'Dzień dobry.']]),
			part(1, [[610, 620, 'Speaker 1', 'Dobrze.']]),
		]);

		expect(spoken(joined)).toEqual([
			'Olga: Dzień dobry.',
			'Speaker 1: Dobrze.',
		]);
	});

	it('drops the lead-in of a part whose earlier neighbour is missing', () => {
		const joined = joinSeams([
			NAMED_FIRST,
			part(2, [
				[1175, 1190, 'Speaker 1', 'From the part that failed.'],
				[1205, 1210, 'Speaker 2', 'Świetnie.'],
			]),
		]);

		expect(spoken(joined).slice(-2)).toEqual([
			'Olga: A teraz przeczytamy',
			'Speaker 2: Świetnie.',
		]);
	});

	it('matches on the labelled lines when the earlier part left one unlabelled', () => {
		const earlier: SeamPart = {
			offsetSeconds: 0,
			endSeconds: PART_SECONDS,
			transcript: buildTranscript([
				{ start: 570, end: 580, text: 'Somebody.' },
				{ start: 582, end: 598, speaker: 'Olga', text: 'Proszę.' },
			]),
		};

		const joined = joinSeams([
			earlier,
			part(1, [
				[582, 598, 'Speaker 1', 'Proszę.'],
				[610, 620, 'Speaker 1', 'Dalej.'],
			]),
		]);

		expect(spoken(joined).at(-1)).toBe('Olga: Dalej.');
	});

	it('drops the lead-in of a part that comes first, with nothing before it', () => {
		const joined = joinSeams([
			part(1, [
				[575, 585, 'Speaker 1', 'Lead-in.'],
				[610, 620, 'Speaker 1', 'Own stretch.'],
			]),
		]);

		expect(spoken(joined)).toEqual(['Speaker 1: Own stretch.']);
	});

	it('does not match against an earlier part whose end was never measured', () => {
		const whole: SeamPart = {
			offsetSeconds: 0,
			transcript: buildTranscript([
				{ start: 575, end: 585, speaker: 'Olga', text: 'Earlier.' },
			]),
		};

		const joined = joinSeams([
			whole,
			part(1, [
				[575, 585, 'Speaker 1', 'Earlier.'],
				[610, 620, 'Speaker 1', 'Later.'],
			]),
		]);

		expect(spoken(joined)).toEqual(['Olga: Earlier.', 'Speaker 1: Later.']);
	});

	it('returns parts answered out of order in timeline order', () => {
		const first = part(0, [[10, 20, 'Olga', 'First.']], 0);
		const second = part(1, [[610, 620, 'Olga', 'Second.']], 0);

		expect(spoken(joinSeams([second, first]))).toEqual([
			'Olga: First.',
			'Olga: Second.',
		]);
	});

	it('takes parts without a lead-in exactly as they were transcribed', () => {
		const parts = [
			part(0, [[10, 20, 'Speaker 1', 'First.']], 0),
			part(1, [[610, 620, 'Speaker 2', 'Second.']], 0),
		];

		expect(joinSeams(parts)).toEqual(parts);
	});

	it('keeps a line with no speaker when the parts carry no labels', () => {
		const unlabelled: SeamPart = {
			offsetSeconds: PART_SECONDS - LEAD_IN_SECONDS,
			leadInSeconds: LEAD_IN_SECONDS,
			endSeconds: 2 * PART_SECONDS,
			transcript: buildTranscript([
				{ start: 5, end: 10, text: 'Lead-in.' },
				{ start: 40, end: 50, text: 'Own stretch.' },
			]),
		};

		const joined = joinSeams([part(0, []), unlabelled]);

		expect(joined[1]?.transcript.segments.map((s) => s.text)).toEqual([
			'Own stretch.',
		]);
	});
});
