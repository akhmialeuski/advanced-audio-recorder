/**
 * The advanced two-pass scenario, one declining reason at a time.
 *
 * Every one of these used to be a nested condition inside the four-hundred-line
 * run method, which is why none of them had a test of its own: reaching one
 * meant driving a whole transcription. The scenario answers with a value now,
 * so each reason is a return the test can name.
 * @module tests/unit/AdvancedTwoPassRunner.test
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

jest.mock('src/transcription/advanced/contextPipeline', () => ({
	generateContext: jest.fn(),
}));

const mockGenerateContext = jest.mocked(generateContext);

/** A transcript of the given text as one segment, which is all the run compares. */
function transcriptOf(text: string): Transcript {
	return {
		language: 'ru',
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
	const runner = new AdvancedTwoPassRunner({
		settings: mergeSettings({ transcriptionAdvancedSettingsEnabled: true }),
		baseline: transcriptOf('a first pass of comparable length here now'),
		transcribeOptions: { diarize: false, wordTimestamps: false },
		engineId: 'whisper-api',
		sourcePath: 'rec.webm',
		secondPassResults,
		progressBase: 0.4,
		progressSpan: 0.4,
		transcribePass: passBehaviour,
		createLlm: () => ({
			id: 'openai-compatible',
			label: 'OpenAI',
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
