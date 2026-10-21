/**
 * The advanced two-pass scenario, one declining reason at a time.
 *
 * Every one of these used to be a nested condition inside the four-hundred-line
 * run method, which is why none of them had a test of its own: reaching one
 * meant driving a whole transcription. The scenario answers with a value now,
 * so each reason is a return the test can name.
 * @module tests/integration/AdvancedTwoPassRunner.test
 */

import {
	AdvancedTwoPassRunner,
	advancedSkipNotice,
	type AdvancedTwoPassInput,
	type PassResult,
	type TranscribePass,
} from 'src/transcription/advanced/AdvancedTwoPassRunner';
import { generateContext } from 'src/transcription/advanced/contextPipeline';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { EngineLabel } from 'src/providers/providers';
import { TRANSCRIPTION_PROVIDER_IDS, LLM_PROVIDER_IDS } from 'src/constants';

jest.mock('src/transcription/advanced/contextPipeline', () => ({
	generateContext: jest.fn(),
}));

const mockGenerateContext = jest.mocked(generateContext);

/**
 * A transcript of the given text as one segment, in the language it was
 * detected as. The run compares both: the length against the baseline, and the
 * language the pass answered in.
 */
function transcriptOf(text: string, language = 'ru'): Transcript {
	return {
		language,
		segments: [{ start: 0, end: 10, text }],
		speakers: [],
	};
}

/** Context rich enough for the bias planner to produce a prompt sentence. */
function usableContext(): Awaited<ReturnType<typeof generateContext>> {
	return {
		topic: 'quarterly planning',
		names: ['Anatol'],
		jargon: ['catchain'],
		acronyms: ['TON'],
		promptSentence: 'A meeting about quarterly planning, TON and catchain.',
		keyterms: ['catchain', 'TON'],
	};
}

/** A run told the recording switches between Polish and Ukrainian. */
const POLISH_AND_UKRAINIAN: AdvancedTwoPassInput['transcribeOptions'] = {
	diarize: false,
	wordTimestamps: false,
	language: 'pl',
	languages: ['pl', 'uk'],
};

/**
 * A second pass of comparable length that came back in `language`.
 * @param language - The language the pass reports
 */
function secondPassIn(language: string): TranscribePass {
	return async (_options, passResults) => {
		passResults.push({
			offsetSeconds: 0,
			transcript: transcriptOf(
				'a second pass of comparable length here',
				language,
			),
		});
	};
}

/**
 * Parts fifteen minutes apart, one per language, each a single segment
 * tagged with its language the way a several-language Gemini part is.
 * @param languages - The language of each part's segment
 */
function partsTagged(...languages: string[]): PassResult[] {
	return languages.map((language, index) => ({
		offsetSeconds: index * 900,
		transcript: {
			segments: [
				{
					start: 0,
					end: 10,
					text: 'a part of comparable length',
					language,
				},
			],
			speakers: [],
		},
	}));
}

/**
 * A second pass that came back as the given parts.
 * @param parts - The parts the pass returns
 */
function secondPassOf(parts: PassResult[]): TranscribePass {
	return async (_options, passResults) => {
		passResults.push(...parts);
	};
}

function createSut(
	overrides: Partial<AdvancedTwoPassInput> = {},
	passBehaviour: TranscribePass = async (
		_options,
		passResults: PassResult[],
	) => {
		passResults.push({
			offsetSeconds: 0,
			transcript: transcriptOf('a second pass of comparable length here'),
		});
	},
): { runner: AdvancedTwoPassRunner; secondPassResults: PassResult[] } {
	const secondPassResults: PassResult[] = [];
	const baseline =
		overrides.baseline ??
		transcriptOf('a first pass of comparable length here now');
	const runner = new AdvancedTwoPassRunner({
		settings: mergeSettings({ transcriptionAdvancedSettingsEnabled: true }),
		baseline,
		baselineResults: [{ offsetSeconds: 0, transcript: baseline }],
		transcribeOptions: { diarize: false, wordTimestamps: false },
		engineId: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		sourcePath: 'rec.webm',
		secondPassResults,
		progressBase: 0.4,
		progressSpan: 0.4,
		transcribePass: passBehaviour,
		createLlm: () => ({
			id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			label: EngineLabel.OpenAi,
			complete: jest.fn(),
		}),
		token: { isCancelled: (): boolean => false },
		rethrowIfCancelled: (): void => {},
		throwIfCancelled: (): void => {},
		unsupportedReason: null,
		...overrides,
	});
	return { runner, secondPassResults };
}

describe('a second pass that is declined', () => {
	it('declines before any LLM call when the engine cannot carry a bias', async () => {
		const createLlm = jest.fn();
		const { runner } = createSut({
			unsupportedReason: 'the selected engine cannot bias recognition',
			createLlm,
		});

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'engine-unsupported',
			detail: 'the selected engine cannot bias recognition',
		});
		expect(createLlm).not.toHaveBeenCalled();
	});

	it('declines when the agents mined nothing the engine can use', async () => {
		mockGenerateContext.mockResolvedValue(null);
		const { runner } = createSut();

		const outcome = await runner.run();

		expect(outcome).toEqual({ status: 'skipped', reason: 'no-context' });
	});

	it('declines when a part of the second pass did not come back', async () => {
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut(
			{},
			async (_o, passResults, passFailed) => {
				passFailed.push({
					label: '0:00-0:10',
					message: 'rate limited',
					startSeconds: 0,
					endSeconds: 10,
				});
				passResults.push({
					offsetSeconds: 0,
					transcript: transcriptOf(
						'a second pass of comparable length',
					),
				});
			},
		);

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'incomplete-second-pass',
		});
	});

	it('declines when the second pass came back too short to trust', async () => {
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut({}, async (_o, passResults) => {
			passResults.push({
				offsetSeconds: 0,
				transcript: transcriptOf('short'),
			});
		});

		const outcome = await runner.run();

		expect(outcome).toEqual({ status: 'skipped', reason: 'too-short' });
	});

	it('declines when the second pass answered in another language', async () => {
		// The bias is dense with English tokens, and a decode left to detect
		// the language again can flip a Russian recording into English. The
		// options carry the first pass's language, but an engine that reads no
		// language hint discards that field, so the answer is what decides.
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut({}, secondPassIn('en'));

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'language-drift',
		});
	});

	it('declines a several-language pass that came back in none of the listed languages', async () => {
		// The bias can flip the decode into English whatever languages were
		// listed: its segments are then tagged "other", and the language the
		// pass reports is the one the engine named for the whole answer.
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut(
			{
				transcribeOptions: POLISH_AND_UKRAINIAN,
				baseline: transcriptOf(
					'a first pass of comparable length here now',
					'pl',
				),
			},
			secondPassIn('en'),
		);

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'language-drift',
		});
	});

	it('declines a several-language pass when one of its parts drifted out of the list', async () => {
		// Each part is its own request, so the middle one can flip into
		// English while the stitched pass still reads as Polish.
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut(
			{
				transcribeOptions: POLISH_AND_UKRAINIAN,
				baselineResults: partsTagged('pl', 'uk', 'pl'),
			},
			secondPassOf(partsTagged('pl', 'other', 'pl')),
		);

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'language-drift',
		});
	});

	it('adopts a several-language pass whose part outside the list was heard there by the first pass too', async () => {
		// A stretch genuinely spoken in a language nobody listed is tagged
		// "other" by both passes, and is no reason to lose the second one.
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut(
			{
				transcribeOptions: POLISH_AND_UKRAINIAN,
				baselineResults: partsTagged('pl', 'other', 'uk'),
			},
			secondPassOf(partsTagged('pl', 'other', 'pl')),
		);

		const outcome = await runner.run();

		expect(outcome.status).toBe('improved');
	});

	it('declines a single-language pass whose later part answered in another language', async () => {
		// The stitched pass takes its language from the first part, so a
		// drifted second part passed unseen when the whole was judged.
		mockGenerateContext.mockResolvedValue(usableContext());
		const partsIn = (...languages: string[]): PassResult[] =>
			languages.map((language, index) => ({
				offsetSeconds: index * 900,
				transcript: transcriptOf(
					'a part of comparable length',
					language,
				),
			}));
		const { runner } = createSut(
			{ baselineResults: partsIn('ru', 'ru') },
			secondPassOf(partsIn('ru', 'en')),
		);

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'skipped',
			reason: 'language-drift',
		});
	});

	it('declines when the scenario threw part way through', async () => {
		mockGenerateContext.mockRejectedValue(new Error('agent exploded'));
		const { runner } = createSut();

		const outcome = await runner.run();

		expect(outcome).toEqual({ status: 'skipped', reason: 'failed' });
	});

	it('re-throws a cancellation instead of declining', async () => {
		mockGenerateContext.mockRejectedValue(new Error('aborted'));
		const { runner } = createSut({
			rethrowIfCancelled: (error): void => {
				throw error;
			},
		});

		await expect(runner.run()).rejects.toThrow('aborted');
	});
});

describe('a second pass that is adopted', () => {
	// The outcome carries nothing but the transcript. A pass that lost a part
	// is turned into a skip before it can be adopted, so an adopted one has no
	// failures to report and the caller clears the first pass's own without
	// testing anything. The exact match is what keeps a list of them from
	// growing back onto an outcome that can never carry one.
	it('answers with the improved transcript and nothing else', async () => {
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut();

		const outcome = await runner.run();

		expect(outcome).toEqual({
			status: 'improved',
			transcript: expect.objectContaining({
				segments: [
					expect.objectContaining({
						text: 'a second pass of comparable length here',
					}),
				],
			}),
		});
	});

	it('adopts a pass whose prevailing language tipped on a several-language run', async () => {
		// Both passes were told the recording switches between Polish and
		// Ukrainian, so which one most of the text is in is no sign of drift.
		mockGenerateContext.mockResolvedValue(usableContext());
		const { runner } = createSut(
			{
				transcribeOptions: POLISH_AND_UKRAINIAN,
				baseline: transcriptOf(
					'a first pass of comparable length here now',
					'pl',
				),
			},
			secondPassIn('uk'),
		);

		const outcome = await runner.run();

		expect(outcome.status).toBe('improved');
	});

	it('tells the context agents the language most of a several-language draft is in', async () => {
		// "pl" was typed first, but the draft is mostly Ukrainian, so the bias
		// sentence is written in Ukrainian.
		mockGenerateContext.mockResolvedValue(null);
		const { runner } = createSut({
			transcribeOptions: POLISH_AND_UKRAINIAN,
			baseline: transcriptOf('Добрий день, як справи сьогодні', 'uk'),
		});

		await runner.run();

		expect(mockGenerateContext.mock.calls[0]?.[2].language).toBe('uk');
	});

	it('tells the context agents the first listed language when the draft names none', async () => {
		// A draft whose segments were all tagged outside the list, with no
		// language of its own, would otherwise leave the agents guessing.
		mockGenerateContext.mockResolvedValue(null);
		const { runner } = createSut({
			transcribeOptions: POLISH_AND_UKRAINIAN,
			baseline: {
				segments: [{ start: 0, end: 10, text: 'Гэта па-беларуску.' }],
				speakers: [],
			},
		});

		await runner.run();

		expect(mockGenerateContext.mock.calls[0]?.[2].language).toBe('pl');
	});

	it('pins the second pass to the language the first pass detected', async () => {
		mockGenerateContext.mockResolvedValue(usableContext());
		const transcribePass = jest.fn<
			ReturnType<TranscribePass>,
			Parameters<TranscribePass>
		>(async (_options, passResults) => {
			passResults.push({
				offsetSeconds: 0,
				transcript: transcriptOf(
					'a second pass of comparable length here',
				),
			});
		});
		const { runner } = createSut({}, transcribePass);

		await runner.run();

		expect(transcribePass).toHaveBeenCalledWith(
			expect.objectContaining({ language: 'ru' }),
			expect.anything(),
			expect.anything(),
			0.4,
			0.4,
			'Second pass: transcribing',
		);
	});
});

describe('the sentence a declined pass carries', () => {
	it.each([
		{ reason: 'no-context' as const, fragment: 'no usable context' },
		{
			reason: 'incomplete-second-pass' as const,
			fragment: 'second pass failed',
		},
		{ reason: 'too-short' as const, fragment: 'came back too short' },
		{
			reason: 'language-drift' as const,
			fragment: 'came back in a different language',
		},
		{ reason: 'failed' as const, fragment: 'transcription failed' },
	])(
		'names $reason and says the transcript is kept',
		({ reason, fragment }) => {
			const sentence = advancedSkipNotice({ reason });

			expect(sentence).toContain(fragment);
			expect(sentence).toContain('transcript');
		},
	);

	it('repeats the engine reason it was given', () => {
		const sentence = advancedSkipNotice({
			reason: 'engine-unsupported',
			detail: 'the model cannot bias recognition',
		});

		expect(sentence).toContain('the model cannot bias recognition');
	});
});
