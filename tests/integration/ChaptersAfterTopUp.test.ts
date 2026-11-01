/**
 * Regression for auto chapters after a top-up of the parts that failed. A run
 * that loses a part still generates chapters, from the transcript with the
 * gap, and the top-up that brings the part back rewrites the transcript files
 * but used to leave those chapters as they were. The recording then looked
 * fully transcribed while no chapter covered the stretch the top-up restored.
 *
 * Driven through the real objects: the operation every surface runs a
 * recording through, the pipeline that writes the JSON transcript and records
 * the failed part, a real sidecar store over an in-memory vault, the real
 * chapter service writing into that sidecar, and the top-up action every menu
 * and the command line call. Only the engine and the LLM are stood in for.
 */

import type { TFile } from 'obsidian';
import { retryFailedParts } from 'src/actions/file/recordingEdits';
import type { ActionServices } from 'src/actions/core/actionServices';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { isAutoChapterId } from 'src/chapters/chapterGeneration';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';
import { EngineLabel } from 'src/providers/providers';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { RecordingTranscriber } from 'src/transcription/RecordingTranscriber';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import type { PartFailure } from 'src/transcription/partFailure';
import type { TranscribeRunResult } from 'src/transcription/TranscriptionService';
import {
	TranscriptDestination,
	TranscriptFileFormat,
	type TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';
import { partial } from '../helpers/doubles';
import { waitFor } from '../helpers/async';
import { completed } from '../helpers/llmDoubles';

/** What the engine answers each run with, in the order the runs happen. */
const mockEngineRun = jest.fn<Promise<TranscribeRunResult>, unknown[]>();

// Only the engine is stood in for: the run and the top-up both construct the
// service, so one spy answers the first run and then the top-up.
jest.mock('src/transcription/TranscriptionService', () => ({
	...jest.requireActual<object>('src/transcription/TranscriptionService'),
	TranscriptionService: jest.fn(() => ({ run: mockEngineRun })),
}));

const AUDIO_PATH = 'audio/standup.webm';

/** The part the first run lost, with the bounds a top-up asks for. */
const LOST: PartFailure = {
	label: '0:30-2:00',
	message: 'rate limited',
	startSeconds: 30,
	endSeconds: 120,
};

const OPENING: TranscriptSegment = { start: 0, end: 30, text: 'the opening' };
const MIDDLE: TranscriptSegment = { start: 60, end: 90, text: 'the middle' };
const CLOSING: TranscriptSegment = {
	start: 120,
	end: 150,
	text: 'the closing',
};

/** Markers the user placed by hand, which no generation may touch. */
const BY_HAND: PlayerMarker[] = [
	{ id: 'mine-1', time: 10, label: 'Agenda', kind: MARKER_KIND.bookmark },
	{ id: 'mine-2', time: 140, label: 'Wrap-up', kind: MARKER_KIND.chapter },
];

/** Settings under which chapters follow every finished run. */
const CHAPTERS_AFTER_RUN: Partial<AudioRecorderSettings> = {
	transcriptionAutoChaptersEnabled: true,
	transcriptionAutoChaptersOnTranscribe: true,
};

/**
 * What the engine answers one run with.
 * @param segments - The segments that came back
 * @param missingParts - The parts it failed on
 * @returns The run's result
 */
function engineAnswer(
	segments: TranscriptSegment[],
	missingParts: PartFailure[],
): TranscribeRunResult {
	return {
		transcript: { segments, speakers: [], language: 'en' },
		markdown: '',
		cost: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			usd: 0.02,
			usage: {},
		},
		missingParts,
		sentSeconds: 90,
	};
}

/**
 * An LLM that opens a chapter on every line of the transcript it is shown,
 * titled by that line, so the chapters say which lines they were cut from.
 * @param prompts - Receives every prompt it is sent
 * @returns The provider
 */
function chapterPerLineLlm(prompts: LlmPrompt[]): LlmProvider {
	const lines = [OPENING, MIDDLE, CLOSING];
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: EngineLabel.Gemini,
		complete: (prompt: LlmPrompt) => {
			prompts.push(prompt);
			const chapters = lines
				.filter((line) => prompt.user.includes(line.text))
				.map((line) => ({ time: line.start, title: line.text }));
			return Promise.resolve(completed(JSON.stringify(chapters)));
		},
	};
}

/**
 * A recording transcribed by the real operation into a JSON file, with one
 * part lost and its chapters generated as the run's settings ask, and the
 * services the top-up action is handed over the same vault, sidecar and
 * chapter service.
 * @param scenario - The case
 * @param scenario.stored - The plugin settings this case varies, which the
 *   top-up and the chapter service read
 * @param scenario.run - What the first run changes on top of them, as the
 *   dialog and the command line do for one run without storing it
 * @param scenario.topUp - What the engine answers the top-up with; by
 *   default the lost part comes back whole
 * @returns The action's services, the sidecar, and every prompt the LLM got
 */
async function transcribedWithAGap({
	stored,
	run = {},
	topUp = engineAnswer([MIDDLE], []),
}: {
	stored: Partial<AudioRecorderSettings>;
	run?: Partial<AudioRecorderSettings>;
	topUp?: TranscribeRunResult;
}): Promise<{
	file: TFile;
	services: ActionServices;
	sidecar: RecordingSidecarStore;
	prompts: LlmPrompt[];
}> {
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptDestination: TranscriptDestination.File,
		transcriptFileFormat: TranscriptFileFormat.Json,
		...stored,
	});
	const { vault } = fakeVaultFiles([[AUDIO_PATH, '']]);
	const { app } = createMockApp({ vault });
	const file = vault.getFileByPath(AUDIO_PATH) as TFile;
	const sidecar = new RecordingSidecarStore(app);
	await sidecar.updateMarkers(AUDIO_PATH, () => BY_HAND);
	const prompts: LlmPrompt[] = [];
	const autoChapters = new AutoChapterService(
		app,
		() => settings,
		sidecar,
		undefined,
		{
			createLlm: () => chapterPerLineLlm(prompts),
			probeDuration: () => Promise.resolve(150),
		},
	);
	const costs = { recordLlmCall: jest.fn(), recordRun: () => 0.02 };
	mockEngineRun
		.mockResolvedValueOnce(engineAnswer([OPENING, CLOSING], [LOST]))
		.mockResolvedValueOnce(topUp);
	const outcome = await new RecordingTranscriber({
		app,
		sidecar,
		costs: { ...costs, totalUsd: () => 0.02 },
		// Wired the way the plugin wires it, to the chapter service the
		// top-up action is handed too.
		generateChapters: async (target, transcript, signal) => {
			await autoChapters.generate(target, transcript, undefined, signal);
		},
	}).transcribe({
		file,
		settings: { ...settings, ...run },
		notePath: '',
		durationSeconds: () => 150,
	});
	if (outcome.status !== 'done') {
		throw new Error(`The first run ended ${outcome.status}`);
	}
	await outcome.chapters;
	return {
		file,
		sidecar,
		prompts,
		services: partial<ActionServices>({
			app,
			getSettings: () => settings,
			recordingSidecar: sidecar,
			transcriptionCosts: costs,
			autoChapters,
		}),
	};
}

/**
 * The titles of the generated chapters stored for the recording.
 * @param sidecar - Where the chapters are stored
 * @returns The titles, in time order
 */
async function generatedTitles(
	sidecar: RecordingSidecarStore,
): Promise<string[]> {
	const markers = await sidecar.getMarkers(AUDIO_PATH);
	return markers
		.filter((marker) => isAutoChapterId(marker.id))
		.map((marker) => marker.label);
}

describe('auto chapters after a top-up of the parts that failed', () => {
	beforeEach(() => {
		mockEngineRun.mockReset();
	});

	it('generates them again from the transcript the top-up completed', async () => {
		const { file, services, sidecar, prompts } = await transcribedWithAGap({
			stored: CHAPTERS_AFTER_RUN,
		});
		// The run's own chapters were cut from the transcript with the gap.
		expect(await generatedTitles(sidecar)).toEqual([
			'the opening',
			'the closing',
		]);

		const said = await retryFailedParts(file, services);
		await waitFor(() => prompts.length === 2, {
			message: 'the chapters after the top-up were never asked for',
		});
		await waitFor(
			async () => (await generatedTitles(sidecar)).length === 3,
		);

		expect(said).toContain('Recovered 1 segment');
		expect(await generatedTitles(sidecar)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
	});

	it('keeps the bookmarks and chapters placed by hand', async () => {
		const { file, services, sidecar, prompts } = await transcribedWithAGap({
			stored: CHAPTERS_AFTER_RUN,
		});

		await retryFailedParts(file, services);
		await waitFor(
			async () => (await generatedTitles(sidecar)).length === 3,
		);

		const kept = (await sidecar.getMarkers(AUDIO_PATH)).filter(
			(marker) => !isAutoChapterId(marker.id),
		);
		expect(kept).toEqual(BY_HAND);
		expect(prompts).toHaveLength(2);
	});

	it('pays for no chapters when the top-up brought nothing back', async () => {
		// The part failed again with nothing back, so the transcript is the
		// one the run's chapters were already cut from.
		const { file, services } = await transcribedWithAGap({
			stored: CHAPTERS_AFTER_RUN,
			topUp: engineAnswer([], [LOST]),
		});
		// Counted from here, so only what the top-up starts is seen. It is
		// started before the action returns, so no later call can slip past.
		const generate = jest.spyOn(services.autoChapters, 'generate');

		const said = await retryFailedParts(file, services);

		expect(said).toContain('1 part failed again');
		expect(generate).toHaveBeenCalledTimes(0);
	});

	it('regenerates the chapters a run made under its own settings while the stored toggle is off', async () => {
		// The dialog's toggle and the command line's flag turn chapters on for
		// one run without storing it, so only the chapters show what it did.
		const { file, services, sidecar, prompts } = await transcribedWithAGap({
			stored: {
				...CHAPTERS_AFTER_RUN,
				transcriptionAutoChaptersOnTranscribe: false,
			},
			run: { transcriptionAutoChaptersOnTranscribe: true },
		});

		await retryFailedParts(file, services);
		await waitFor(() => prompts.length === 2, {
			message: 'the chapters after the top-up were never asked for',
		});
		await waitFor(
			async () => (await generatedTitles(sidecar)).length === 3,
		);

		expect(await generatedTitles(sidecar)).toContain('the middle');
	});

	it('pays for no chapters when the run it repairs made none', async () => {
		// Chapters turned off for this one run while the stored toggle is on:
		// the recording holds no generated chapters for the top-up to correct.
		const { file, services, prompts } = await transcribedWithAGap({
			stored: CHAPTERS_AFTER_RUN,
			run: { transcriptionAutoChaptersOnTranscribe: false },
		});
		const generate = jest.spyOn(services.autoChapters, 'generate');

		await retryFailedParts(file, services);

		expect(generate).toHaveBeenCalledTimes(0);
		expect(prompts).toHaveLength(0);
	});

	it('leaves the generated chapters alone while auto chapters are switched off', async () => {
		const { file, services, sidecar } = await transcribedWithAGap({
			stored: {
				...CHAPTERS_AFTER_RUN,
				transcriptionAutoChaptersEnabled: false,
			},
			run: CHAPTERS_AFTER_RUN,
		});
		const generate = jest.spyOn(services.autoChapters, 'generate');

		await retryFailedParts(file, services);

		expect(generate).toHaveBeenCalledTimes(0);
		expect(await generatedTitles(sidecar)).toEqual([
			'the opening',
			'the closing',
		]);
	});
});
