/**
 * The dictation run of the transcription service: the audio is prepared into
 * parts exactly as a long recording is, each part is sent on its own, the text
 * comes back in timeline order, and a quick note profile rewrites it. The part
 * planning itself is covered by the audio preparation suites; this one states
 * what preparation returned and checks what the dictation run makes of it.
 * @module tests/integration/transcriptionServiceDictation.test
 */

import {
	TranscriptionCancelledError,
	TranscriptionService,
	type DictationResult,
} from 'src/transcription/TranscriptionService';
import { prepareAudio } from 'src/transcription/audioPrep';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { WhisperResult } from 'src/transcription/providers/whisperResponse';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { CancellationSource } from 'src/utils/cancellation';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { EngineLabel } from 'src/providers/providers';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, type FakeProvider } from '../helpers/providerFixtures';
import { completed } from '../helpers/llmDoubles';
import { partial } from '../helpers/doubles';
import { outcomeOf } from '../helpers/async';
import { noticeMessages } from '../mocks/obsidian';

// Replace audio preparation so the test drives the part count directly without
// decoding real audio (the Web Audio path is unavailable under jsdom).
jest.mock('src/transcription/audioPrep', () =>
	require('../mocks/modules/audioPrep'),
);

/** The instruction a selected quick note profile carries. */
const INSTRUCTION = 'Turn the dictation into a list.';

/**
 * A dictation prepared into parts on the timeline, 150 seconds each.
 * @param count - How many parts preparation returned
 */
function prepareParts(count: number): void {
	jest.mocked(prepareAudio).mockResolvedValue({
		payloads: Array.from({ length: count }, (_, index) => ({
			contentType: 'audio/wav',
			filename: `audio-${String(index)}.wav`,
			offsetSeconds: index * 150,
			endSeconds: (index + 1) * 150,
			createData: () => new ArrayBuffer(4),
		})),
		diarizationSplitWarning: false,
	});
}

/** The service under test and the doubles behind it. */
interface Dictation {
	service: TranscriptionService;
	provider: FakeProvider;
	createProvider: jest.Mock;
	createLlm: jest.Mock;
	complete: jest.Mock;
}

/**
 * Builds a service whose engine answers each part in turn.
 * @param answers - What each request resolves with, or rejects with
 * @param overrides - Settings over a vault that transcribes
 * @returns The service and its doubles
 */
function dictation(
	answers: (WhisperResult | Error)[],
	overrides: Partial<AudioRecorderSettings> = {},
): Dictation {
	prepareParts(answers.length);
	const queue = [...answers];
	const provider = fakeProvider({
		transcribe: async () => {
			const next = queue.shift();
			if (next instanceof Error || next === undefined) {
				throw next ?? new Error('no answer');
			}
			return next;
		},
	});
	const complete = jest.fn(async () => completed('- rewritten'));
	const createLlm = jest.fn(() =>
		partial<LlmProvider>({
			id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			label: EngineLabel.OpenAi,
			complete,
		}),
	);
	const settings = mergeSettings({
		transcriptionEnabled: true,
		...overrides,
	});
	const createProvider = jest.fn(() => provider);
	const service = new TranscriptionService(
		createMockApp().app,
		() => settings,
		{ createProvider, createLlm },
	);
	return { service, provider, createProvider, createLlm, complete };
}

/**
 * Runs the dictation over a clip in memory.
 * @param run - The service to dictate through
 * @param cancel - Cancellation for the run, when the test cancels it
 * @returns What the run returned
 */
function dictate(
	run: Dictation,
	cancel?: CancellationSource,
): Promise<DictationResult> {
	return run.service.dictate(
		{ bytes: new ArrayBuffer(4), extension: 'webm' },
		{ token: cancel?.token },
	);
}

/**
 * Settings selecting a quick note profile with the given body.
 * @param body - The profile's instruction
 * @param sourcePath - The note it is read from, when it is note-backed
 * @returns Settings fields to merge
 */
function withProfile(
	body: string,
	sourcePath?: string,
): Partial<AudioRecorderSettings> {
	return {
		profiles: [
			{
				id: 'q1',
				kind: 'quickNote',
				name: 'List',
				body,
				...(sourcePath === undefined ? {} : { sourcePath }),
			},
		],
		selectedProfileIds: {
			...mergeSettings({}).selectedProfileIds,
			quickNote: 'q1',
		},
	};
}

/**
 * One part the engine heard.
 * @param text - What it heard
 * @returns The engine's answer
 */
const heard = (text: string): WhisperResult => ({
	segments: [{ start: 0, end: 140, text }],
});

describe('a long dictation', () => {
	it('is sent part by part and comes back as one text in timeline order', async () => {
		const run = dictation([
			heard('first thought'),
			heard('second thought'),
		]);

		const result = await dictate(run);

		expect(run.provider.transcribe).toHaveBeenCalledTimes(2);
		expect(result.text).toBe('first thought second thought');
		expect(result.sentSeconds).toBe(300);
	});

	it('is transcribed once even when the advanced two-pass mode is on', async () => {
		// The second pass doubles the engine bill and adds LLM agents; a
		// dictation is not the recording that mode was switched on for.
		const run = dictation([heard('first'), heard('second')], {
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		});

		await dictate(run);

		expect(run.provider.transcribe).toHaveBeenCalledTimes(2);
		expect(run.createLlm).not.toHaveBeenCalled();
	});

	it('keeps the parts that were heard when one part fails, and says a part is missing', async () => {
		const run = dictation([heard('kept'), new Error('400 bad audio')]);

		const result = await dictate(run);

		expect(result.text).toBe('kept');
		expect(noticeMessages()).toEqual([
			expect.stringMatching(
				/^Some audio could not be transcribed.*400 bad audio$/,
			),
		]);
	});
});

describe("a dictation's inputs and its rewrite", () => {
	it('is transcribed by the quick note transcription engine, not the one recordings use', async () => {
		// A dictation and a recording are different jobs, and a vault may
		// transcribe its meetings with one service and its dictations with
		// another; the engine, its limits and its price must all follow.
		const run = dictation([heard('buy milk')], {
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			quickNoteTranscriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		});

		const result = await dictate(run);

		const [used] = run.createProvider.mock.calls[0] ?? [];
		expect(used).toMatchObject({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		});
		expect(result.cost.engineId).toBe(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM);
		expect(result.settings.transcriptionProvider).toBe(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		);
	});

	it('biases the engine toward the selected dictionary terms', async () => {
		// A dictation names the same people and products the recordings do,
		// so it spells them the way the vault does.
		const run = dictation([heard('ship it')], {
			transcriptionAdvancedSettingsEnabled: true,
			profiles: [
				{
					id: 'd1',
					kind: 'dictionary',
					name: 'Team',
					body: 'Kubernetes',
				},
			],
			selectedProfileIds: {
				...mergeSettings({}).selectedProfileIds,
				dictionary: 'd1',
			},
		});

		await dictate(run);

		const [, options] = run.provider.transcribe.mock.calls[0] ?? [];
		expect(options?.dictionary).toEqual(['Kubernetes']);
	});

	it('keeps the text as heard when the rewrite comes back empty', async () => {
		const run = dictation([heard('buy milk')], withProfile(INSTRUCTION));
		run.complete.mockResolvedValue(completed('   '));

		const result = await dictate(run);

		expect(result.text).toBe('buy milk');
	});

	it.each([
		{ name: 'only silence', answer: heard(' ') },
		{ name: 'no segments at all', answer: { segments: [] } },
	])(
		'spends nothing on a rewrite when the engine heard $name',
		async ({ answer }) => {
			const run = dictation([answer], withProfile(INSTRUCTION));

			const result = await dictate(run);

			expect(result.text).toBe('');
			expect(run.complete).not.toHaveBeenCalled();
		},
	);

	it('refuses a dictation cancelled before it starts, without preparing its audio', async () => {
		// The quick note reads its clip before handing it over, and an unload
		// can cancel it meanwhile. Preparing would decode audio nobody wants.
		const cancel = new CancellationSource();
		const run = dictation([heard('buy milk')]);
		cancel.cancel();

		const outcome = await outcomeOf(dictate(run, cancel));

		expect(outcome).toEqual({
			error: expect.any(TranscriptionCancelledError) as Error,
		});
		expect(prepareAudio).not.toHaveBeenCalled();
		expect(run.provider.transcribe).not.toHaveBeenCalled();
	});

	it('ends as cancelled, not as a failed rewrite, when cancelled during the rewrite', async () => {
		// The rewrite falls back to the text as heard when the call fails; a
		// cancel is not a failure, and must not insert anything.
		const cancel = new CancellationSource();
		const run = dictation([heard('buy milk')], withProfile(INSTRUCTION));
		run.complete.mockImplementation(async () => {
			cancel.cancel();
			throw new Error('aborted');
		});

		const outcome = await outcomeOf(dictate(run, cancel));

		expect(outcome).toEqual({
			error: expect.any(TranscriptionCancelledError) as Error,
		});
		expect(noticeMessages()).toEqual([]);
	});

	it('names the note of a profile it could not read, and rewrites with the text last read from it', async () => {
		const run = dictation(
			[heard('buy milk')],
			withProfile(INSTRUCTION, 'Prompts/List.md'),
		);

		await dictate(run);

		expect(noticeMessages()).toEqual([
			expect.stringContaining('Prompts/List.md'),
		]);
		const [prompt] = run.complete.mock.calls[0] ?? [];
		expect(prompt).toEqual({ system: INSTRUCTION, user: 'buy milk' });
	});
});
