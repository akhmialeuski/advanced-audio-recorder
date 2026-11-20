/**
 * Tests that the transcription service turns provider-reported usage into
 * a run cost: actuals summed across parts, priced by the configured
 * engine and model, surfaced live through onCost and in the run result.
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import type { WhisperResult } from 'src/transcription/providers/whisperResponse';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider } from '../helpers/providerFixtures';

const audioFile = partial<TFile>({
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
});

/**
 * A whole-file engine that answers every request with the same result.
 * @param result - What one transcribe call resolves with
 * @returns The provider double
 */
function makeProvider(result: WhisperResult): TranscriptionProvider {
	return fakeProvider({ transcribe: result });
}

function makeApp(): App {
	return createMockApp({
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
	}).app;
}

async function runWith(
	result: WhisperResult,
	overrides: Partial<AudioRecorderSettings>,
	onCost?: (cost: TranscribeRunCost) => void,
): Promise<TranscribeRunCost> {
	const service = new TranscriptionService(
		makeApp(),
		() => mergeSettings(overrides),
		{ createProvider: () => makeProvider(result) },
	);
	const run = await service.run(audioFile, {
		notePathForLinks: 'note.md',
		onCost,
	});
	return run.cost;
}

const segments = [{ start: 0, end: 1, text: 'hi' }];

describe('TranscriptionService run cost', () => {
	it('prices reported audio seconds with the engine rate', async () => {
		const cost = await runWith(
			{ segments, usage: { audioSeconds: 600 } },
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
		);
		expect(cost.engineId).toBe(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM);
		expect(cost.usage).toEqual({ audioSeconds: 600 });
		expect(cost.usd).toBeCloseTo(0.043, 10);
	});

	it('prices reported audio-input tokens with the Gemini audio rate', async () => {
		const cost = await runWith(
			{
				segments,
				usage: {
					inputTokens: 1_000_000,
					audioInputTokens: 1_000_000,
					outputTokens: 0,
				},
			},
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				geminiModel: 'gemini-2.5-flash',
			},
		);
		expect(cost.usd).toBeCloseTo(1.0, 10);
	});

	it('prices the text portion of the Gemini prompt at the cheaper text rate', async () => {
		// 1M audio input at $1/M plus 100k text prompt at $0.30/M plus 10k
		// output at $2.50/M.
		const cost = await runWith(
			{
				segments,
				usage: {
					inputTokens: 1_100_000,
					audioInputTokens: 1_000_000,
					outputTokens: 10_000,
				},
			},
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				geminiModel: 'gemini-2.5-flash',
			},
		);
		expect(cost.usd).toBeCloseTo(1.0 + 0.03 + 0.025, 10);
	});

	it('returns a null cost for a model with no built-in rate', async () => {
		const cost = await runWith(
			{ segments, usage: { audioSeconds: 600 } },
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'my-custom-model',
			},
		);
		expect(cost.usd).toBeNull();
		// The usage itself is still reported for display.
		expect(cost.usage).toEqual({ audioSeconds: 600 });
	});

	it('returns a null cost when the provider reported no usage', async () => {
		const cost = await runWith(
			{ segments },
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
		);
		expect(cost.usd).toBeNull();
		expect(cost.usage).toEqual({});
	});

	it('reports zero cost for the local engine', async () => {
		const cost = await runWith(
			{ segments },
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			},
		);
		expect(cost.usd).toBe(0);
	});

	it.each([
		{
			name: 'the caller already read the bytes',
			audioBytes: new ArrayBuffer(8),
			reads: 0,
		},
		{
			name: 'the caller passed none',
			audioBytes: undefined,
			reads: 1,
		},
		{
			// An empty buffer is bytes the caller has: re-reading would send
			// different audio than the caller measured and priced.
			name: 'the caller passed an empty buffer',
			audioBytes: new ArrayBuffer(0),
			reads: 0,
		},
	])(
		'reads the file $reads times when $name',
		async ({ audioBytes, reads }) => {
			const readBinary = jest.fn(async () => new ArrayBuffer(4));
			const app = createMockApp({
				vault: { readBinary },
				fileManager: {
					generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
				},
			}).app;
			const service = new TranscriptionService(
				app,
				() =>
					mergeSettings({
						transcriptionProvider:
							TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
						deepgramModel: 'nova-3',
					}),
				{
					createProvider: () =>
						makeProvider({ segments, usage: { audioSeconds: 60 } }),
				},
			);

			await service.run(audioFile, {
				notePathForLinks: 'note.md',
				...(audioBytes === undefined ? {} : { audioBytes }),
			});

			expect(readBinary).toHaveBeenCalledTimes(reads);
		},
	);

	it('invokes onCost with the cumulative cost after each part', async () => {
		const updates: TranscribeRunCost[] = [];
		await runWith(
			{ segments, usage: { audioSeconds: 60 } },
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			(cost) => updates.push(cost),
		);
		expect(updates.length).toBeGreaterThan(0);
		const last = updates[updates.length - 1];
		expect(last?.usd).toBeCloseTo(0.0043, 10);
	});
});

describe('an engine that bills what the run asks for', () => {
	/**
	 * Settings selecting AssemblyAI with a dictionary of the given terms.
	 * @param terms - The dictionary, one term per line
	 * @param overrides - What this case varies beyond that
	 * @returns The overrides a run is started with
	 */
	const assemblyAiWith = (
		terms: string[],
		overrides: Partial<AudioRecorderSettings> = {},
	): Partial<AudioRecorderSettings> => ({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.ASSEMBLYAI,
		assemblyAiModel: 'assemblyai-stt-3-7',
		transcriptionAdvancedSettingsEnabled: true,
		profiles: [
			{
				id: 'd1',
				kind: 'dictionary',
				name: 'Team',
				body: terms.join('\n'),
			},
		],
		selectedProfileIds: {
			...mergeSettings({}).selectedProfileIds,
			dictionary: 'd1',
		},
		...overrides,
	});

	/** One hour of audio, so a cost reads as the hourly rate. */
	const ONE_HOUR = { segments, usage: { audioSeconds: 3600 } };

	it('bills the bare AssemblyAI rate for a plain run', async () => {
		const cost = await runWith(
			ONE_HOUR,
			assemblyAiWith([], { transcriptionDiarize: false }),
		);

		expect(cost.usd).toBeCloseTo(0.21, 10);
	});

	it('adds speaker labels and keyterms to the AssemblyAI rate', async () => {
		const cost = await runWith(
			ONE_HOUR,
			assemblyAiWith(['Obsidian'], { transcriptionDiarize: true }),
		);

		// 0.21 for the model, 0.02 for speakers, 0.05 for keyterms
		expect(cost.usd).toBeCloseTo(0.28, 10);
	});

	it("plans the dictionary against the selected engine's own model", async () => {
		// Universal-2 carries 200 keyterm words where the flagship carries
		// 1000. A plan made against the Deepgram model id, which is what the
		// service passed for every engine, would have sent all 201.
		const terms = Array.from(
			{ length: 201 },
			(_value, index) => `term${String(index)}`,
		);
		const provider = fakeProvider({ transcribe: ONE_HOUR });
		const service = new TranscriptionService(
			makeApp(),
			() =>
				mergeSettings(
					assemblyAiWith(terms, {
						assemblyAiModel: 'universal-2',
						deepgramModel: 'nova-3',
					}),
				),
			{ createProvider: () => provider },
		);

		await service.run(audioFile, { notePathForLinks: 'note.md' });

		const [, options] = provider.transcribe.mock.calls[0] ?? [];
		expect(options?.dictionary).toHaveLength(200);
		expect(jest.mocked(Notice)).toHaveBeenCalledWith(
			expect.stringContaining('only 200 of 201 terms were sent'),
		);
	});
});
