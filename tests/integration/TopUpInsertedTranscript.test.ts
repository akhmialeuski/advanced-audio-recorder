/**
 * Topping up a transcript a run inserted into a note. Such a run writes no
 * transcript file, so the top-up used to refuse it outright and the only way
 * to fill the gap was to pay for the whole recording again.
 *
 * Driven through the real objects: the run every surface uses renders the
 * transcript through the real service and inserts it into an open note, a
 * real sidecar store over an in-memory vault records the note and the failed
 * part, and the real top-up then sends the lost stretch through the same
 * service and fills the note in. Only the engine and audio preparation are
 * stood in for.
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian';
import type { ActionServices } from 'src/actions/core/actionServices';
import {
	describeRetryOutcome,
	retryFailedParts,
} from 'src/actions/file/recordingEdits';
import type { AutoChapterService } from 'src/chapters/AutoChapterService';
import { loadTranscriptLines } from 'src/chapters/transcriptSources';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { EngineLabel } from 'src/providers/providers';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { prepareAudio } from 'src/transcription/audioPrep';
import { createTranscriptionProvider } from 'src/transcription/factories';
import { MISSING_PARTS_CALLOUT_HEAD } from 'src/transcription/partFailure';
import {
	FailedPartRetry,
	serviceRunner,
	type RetryOutcome,
} from 'src/transcription/retryFailedParts';
import { transcribeFile } from 'src/transcription/runTranscription';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import { LlmTask } from 'src/transcription/llmPostProcess';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import {
	TranscriptDestination,
	TranscriptFileFormat,
	type Transcript,
	type TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import {
	createMarkdownView,
	createMockApp,
	fakeVaultFiles,
} from '../helpers/createApp';
import { partial } from '../helpers/doubles';
import { completed } from '../helpers/llmDoubles';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { FakeEditor } from '../helpers/transcriptEditHarness';

jest.mock('src/transcription/audioPrep', () =>
	require('../mocks/modules/audioPrep'),
);

// The action every menu calls builds its own service, so the engine it
// creates is the one stood in for here.
jest.mock('src/transcription/factories', () => ({
	...jest.requireActual<object>('src/transcription/factories'),
	createTranscriptionProvider: jest.fn(),
}));

const NOTE_PATH = 'meetings/standup.md';
const AUDIO_PATH = 'audio/standup.webm';
const JSON_PATH = 'audio/standup.transcript.json';

/**
 * What the engine answers for each part, in the order it is asked: the
 * segments, a failure, or something done while the request is in flight
 * before the segments it returns.
 */
type PartAnswer = TranscriptSegment[] | Error | (() => TranscriptSegment[]);

/** One segment, timed relative to the start of the part it came back in. */
function said(text: string, start = 5): TranscriptSegment[] {
	return [{ start, end: start + 4, text }];
}

/** The note after the run, with the opening reworded and a remark added. */
function editByHand(text: string): string {
	return text
		.replace('the opening', 'the opening, reworded')
		.replace(/(the closing\n)/, '$1\nMy own remark.\n');
}

interface World {
	app: App;
	files: Map<string, string>;
	audio: TFile;
	store: RecordingSidecarStore;
	settings: AudioRecorderSettings;
	asked: number;
	engine(answers: readonly PartAnswer[]): TranscriptionProvider;
	topUp(answers: PartAnswer[]): Promise<RetryOutcome>;
}

/**
 * A recording of three one-minute parts transcribed into an open note by the
 * real run, the engine answering the parts with the given answers.
 * @param answers - What the engine answers the three parts with
 * @param stored - Settings this case varies
 * @returns The vault, the sidecar, and a top-up over them
 */
async function transcribed(
	answers: PartAnswer[],
	stored: Partial<AudioRecorderSettings> = {},
): Promise<World> {
	const { files, vault } = fakeVaultFiles([
		[AUDIO_PATH, ''],
		[NOTE_PATH, '# Standup\n\n![[standup.webm]]\n'],
	]);
	const audio = vault.getFileByPath(AUDIO_PATH) as TFile;
	const view = createMarkdownView({
		file: vault.getFileByPath(NOTE_PATH) as TFile,
		cursor: { line: 99, ch: 0 },
	});
	view.editor.replaceRange.mockImplementation((text: string) => {
		files.set(NOTE_PATH, `${files.get(NOTE_PATH) ?? ''}${text}`);
	});
	const { app } = createMockApp({
		vault: {
			...vault,
			readBinary: () => Promise.resolve(new ArrayBuffer(4)),
		},
		fileManager: {
			generateMarkdownLink: (
				file: TFile,
				_source: string,
				subpath = '',
				label = '',
			) => `[[${file.name}${subpath}|${label}]]`,
		},
		metadataCache: {
			getFirstLinkpathDest: (path: string) =>
				path === audio.name ? audio : null,
			getFileCache: (file: TFile) =>
				new FakeEditor(files.get(file.path) ?? '').linkCache(),
		},
		workspace: { getLeavesOfType: () => [{ view }] },
	});
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptDestination: TranscriptDestination.Note,
		transcriptFileFormat: TranscriptFileFormat.Json,
		transcriptHeading: '## Transcript',
		...stored,
	});
	const store = new RecordingSidecarStore(app);
	const world: World = {
		app,
		files,
		audio,
		store,
		settings,
		asked: 0,
		engine: (planned) => engine(planned),
		topUp: async (topUpAnswers) => {
			world.asked = 0;
			const provider = engine(topUpAnswers);
			const service = new TranscriptionService(app, () => settings, {
				createProvider: () => provider,
			});
			return new FailedPartRetry(
				app,
				audio,
				store,
				serviceRunner(service, store),
				settings,
			).retry();
		},
	};
	// The queue is a copy, so a case's answers are never used up for the next.
	const engine = (planned: readonly PartAnswer[]) => {
		const queue = [...planned];
		return fakeProvider({
			id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			capabilities: NO_DIARIZATION,
			transcribe: () => {
				world.asked++;
				const planned = queue.shift() ?? [];
				const answer =
					typeof planned === 'function' ? planned() : planned;
				return answer instanceof Error
					? Promise.reject(answer)
					: Promise.resolve({ segments: answer });
			},
		});
	};
	const firstRun = engine(answers);
	await transcribeFile(
		app,
		() => settings,
		audio,
		{ notePathForLinks: NOTE_PATH, sidecar: store },
		{
			createProvider: () => firstRun,
			// Asked only by a run that translates: it marks every numbered
			// line, so the translation below the transcript reads apart.
			createLlm: () => ({
				id: LLM_PROVIDER_IDS.GEMINI,
				label: EngineLabel.Gemini,
				complete: (prompt: { user: string }) =>
					Promise.resolve(
						completed(prompt.user.replace(/$/gm, ' (es)')),
					),
			}),
		},
	);
	return world;
}

/** A run that translates its transcript into a second section of the note. */
const TRANSLATED: Partial<AudioRecorderSettings> = {
	llmPostProcessEnabled: true,
	llmPostProcessTask: LlmTask.Translate,
	llmTranslateTargetLanguage: 'Spanish',
};

/** The note from the heading of the translation section to its end. */
function translationSection(world: World): string {
	const note = world.files.get(NOTE_PATH) ?? '';
	return note.slice(note.indexOf('\n### '));
}

/** The three one-minute parts every recording here is prepared to. */
function preparedInThreeParts(): void {
	jest.mocked(prepareAudio).mockResolvedValue({
		payloads: [0, 60, 120].map((offsetSeconds, index) => ({
			contentType: 'audio/wav',
			filename: `audio-${String(index)}.wav`,
			offsetSeconds,
			endSeconds: offsetSeconds + 60,
			createData: () => new ArrayBuffer(4),
		})),
		diarizationSplitWarning: false,
	});
}

/** The lines of the note that open with a timecode, in order. */
function transcriptLines(world: World): string[] {
	return (world.files.get(NOTE_PATH) ?? '')
		.split('\n')
		.filter((line) => line.startsWith('[[standup.webm#t='));
}

const LOST_MIDDLE: PartAnswer[] = [
	said('the opening'),
	new Error('rate limited'),
	said('the closing'),
];

const LOST_TWO: PartAnswer[] = [
	said('the opening'),
	new Error('rate limited'),
	new Error('rate limited'),
];

beforeEach(preparedInThreeParts);

describe('topping up a transcript inserted into a note', () => {
	it('fills the gap in place and keeps what was edited around it', async () => {
		const world = await transcribed(LOST_MIDDLE);
		world.files.set(
			NOTE_PATH,
			editByHand(world.files.get(NOTE_PATH) ?? ''),
		);

		const outcome = await world.topUp([said('the middle')]);

		expect(transcriptLines(world)).toEqual([
			'[[standup.webm#t=5|0:05]] the opening, reworded',
			'[[standup.webm#t=65|1:05]] the middle',
			'[[standup.webm#t=125|2:05]] the closing',
		]);
		expect(world.files.get(NOTE_PATH)).toContain('My own remark.');
		expect(world.files.get(NOTE_PATH)).not.toContain(
			MISSING_PARTS_CALLOUT_HEAD,
		);
		expect(world.asked).toBe(1);
		expect(describeRetryOutcome(outcome)).toBe(
			'Recovered 1 segment and updated 1 note.',
		);
		expect(await world.store.getFailedParts(AUDIO_PATH)).toBeNull();
	});

	// A top-up whose every part fails throws like any run that got nothing
	// back, so a part failing again is shown beside one that came back.
	it('rewrites the warning with what is still missing', async () => {
		const world = await transcribed(LOST_TWO);

		const outcome = await world.topUp([
			said('the middle'),
			new Error('timed out'),
		]);

		const note = world.files.get(NOTE_PATH) ?? '';
		expect(note).toContain(MISSING_PARTS_CALLOUT_HEAD);
		expect(note).toContain('timed out');
		expect(note).not.toContain('rate limited');
		expect(transcriptLines(world)).toEqual([
			'[[standup.webm#t=5|0:05]] the opening',
			'[[standup.webm#t=65|1:05]] the middle',
		]);
		expect(outcome.stillMissing).toHaveLength(1);
	});

	it('still finds the note on a second top-up of what failed again', async () => {
		const world = await transcribed(LOST_TWO);
		await world.topUp([said('the middle'), new Error('timed out')]);

		const outcome = await world.topUp([said('the closing')]);

		expect(outcome.updatedNotes).toBe(1);
		expect(transcriptLines(world)).toEqual([
			'[[standup.webm#t=5|0:05]] the opening',
			'[[standup.webm#t=65|1:05]] the middle',
			'[[standup.webm#t=125|2:05]] the closing',
		]);
		expect(world.files.get(NOTE_PATH)).not.toContain(
			MISSING_PARTS_CALLOUT_HEAD,
		);
	});

	it('completes both the JSON file and the note of a run that wrote both', async () => {
		const world = await transcribed(LOST_MIDDLE, {
			transcriptDestination: TranscriptDestination.Both,
		});

		const outcome = await world.topUp([said('the middle')]);

		const json = JSON.parse(
			world.files.get(JSON_PATH) ?? '{}',
		) as Transcript;
		expect(json.segments.map((segment) => segment.text)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
		expect(transcriptLines(world)).toHaveLength(3);
		expect(describeRetryOutcome(outcome)).toBe(
			'Recovered 1 segment and rewrote 1 transcript file and updated 1 note.',
		);
	});

	it('refuses before paying when the note has no timecode links to place by', async () => {
		const world = await transcribed(LOST_MIDDLE, {
			transcriptIncludeTimestamps: false,
		});

		const outcome = await world.topUp([said('the middle')]);

		expect(world.asked).toBe(0);
		expect(outcome.blocked).toContain('no timecode links');
		expect(await world.store.getFailedParts(AUDIO_PATH)).not.toBeNull();
	});

	it('leaves a note an older run wrote alone', async () => {
		const world = await transcribed(LOST_MIDDLE);
		const section = await world.store.getTranscript(AUDIO_PATH);
		const [note] = section.noteOutputs;
		if (!note) {
			throw new Error('The run recorded no note');
		}
		await world.store.recordNoteOutput(AUDIO_PATH, {
			...note,
			writtenAt: '2000-01-01T00:00:00.000Z',
		});

		const outcome = await world.topUp([said('the middle')]);

		expect(outcome.blocked).toContain('Neither is left for this recording');
		expect(world.asked).toBe(0);
	});

	it('keeps a note the vault refuses to write as it was', async () => {
		const world = await transcribed(LOST_MIDDLE);
		const before = world.files.get(NOTE_PATH);
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The kept note is the assertion.
		});
		jest.spyOn(world.app.vault, 'process').mockRejectedValue(
			new Error('the note is read-only'),
		);

		const outcome = await world.topUp([said('the middle')]);

		expect(outcome.updatedNotes).toBe(0);
		expect(world.files.get(NOTE_PATH)).toBe(before);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(NOTE_PATH),
			expect.any(Error),
		);
	});

	it('leaves a note whose links were removed while the top-up ran alone', async () => {
		const world = await transcribed(LOST_MIDDLE);
		const unlinked = (world.files.get(NOTE_PATH) ?? '').replace(
			/\[\[standup\.webm#t=\d+\|[^\]]*\]\] /g,
			'',
		);

		const outcome = await world.topUp([
			() => {
				world.files.set(NOTE_PATH, unlinked);
				return said('the middle');
			},
		]);

		expect(outcome.updatedNotes).toBe(0);
		expect(world.files.get(NOTE_PATH)).toBe(unlinked);
	});

	it('removes what a stretch held when it comes back silent', async () => {
		const world = await transcribed(LOST_MIDDLE);
		world.files.set(
			NOTE_PATH,
			(world.files.get(NOTE_PATH) ?? '').replace(
				'[[standup.webm#t=125',
				'[[standup.webm#t=70|1:10]] a stray fragment\n\n[[standup.webm#t=125',
			),
		);

		const outcome = await world.topUp([[]]);

		expect(outcome.updatedNotes).toBe(1);
		expect(transcriptLines(world)).toEqual([
			'[[standup.webm#t=5|0:05]] the opening',
			'[[standup.webm#t=125|2:05]] the closing',
		]);
	});

	// Copy timestamp link puts links into the recording into the user's own
	// text, so a link alone does not make a line part of the transcript.
	it('keeps a remark the user linked into the gap above the transcript', async () => {
		const world = await transcribed(LOST_MIDDLE);
		const remark =
			'Decision at [[standup.webm#t=70|1:10]]: ship on Friday.';
		world.files.set(
			NOTE_PATH,
			(world.files.get(NOTE_PATH) ?? '').replace(
				'## Transcript',
				`${remark}\n\n## Transcript`,
			),
		);

		await world.topUp([said('the middle')]);

		const note = world.files.get(NOTE_PATH) ?? '';
		expect(note).toContain(`${remark}\n\n## Transcript`);
		expect(note).not.toContain(MISSING_PARTS_CALLOUT_HEAD);
		expect(transcriptLines(world)).toEqual([
			'[[standup.webm#t=5|0:05]] the opening',
			'[[standup.webm#t=65|1:05]] the middle',
			'[[standup.webm#t=125|2:05]] the closing',
		]);
	});

	// The translation is rendered with the same links into the recording, so
	// only the section the run's transcript opens bounds what is filled in.
	it('adds a recovered last part to the transcript and not to its translation', async () => {
		const world = await transcribed(
			[
				said('the opening'),
				said('the middle'),
				new Error('rate limited'),
			],
			TRANSLATED,
		);
		const translation = translationSection(world);

		await world.topUp([said('the closing')]);

		expect(translationSection(world)).toBe(translation);
		expect(transcriptLines(world)).toContain(
			'[[standup.webm#t=125|2:05]] the closing',
		);
	});

	it('keeps a translated line that lies inside a retried stretch', async () => {
		const world = await transcribed(LOST_MIDDLE, TRANSLATED);
		const fragment = '[[standup.webm#t=70|1:10]] un fragmento';
		world.files.set(
			NOTE_PATH,
			(world.files.get(NOTE_PATH) ?? '').replace(
				/(\[\[standup\.webm#t=125\|2:05\]\] the closing \(es\))/,
				`${fragment}\n\n$1`,
			),
		);
		const translation = translationSection(world);

		await world.topUp([said('the middle')]);

		expect(translationSection(world)).toBe(translation);
		expect(translation).toContain(fragment);
	});

	it('generates chapters again from the note it filled in', async () => {
		const world = await transcribed(LOST_MIDDLE, {
			transcriptionAutoChaptersEnabled: true,
		});
		jest.mocked(createTranscriptionProvider).mockReturnValue(
			world.engine([said('the middle')]),
		);
		const generate = jest.fn(() => Promise.resolve(true));
		const services = partial<ActionServices>({
			app: world.app,
			getSettings: () => world.settings,
			recordingSidecar: world.store,
			autoChapters: partial<AutoChapterService>({
				hasExistingChapters: () => Promise.resolve(true),
				generate,
			}),
		});

		const notice = await retryFailedParts(world.audio, services);

		expect(notice).toBe('Recovered 1 segment and updated 1 note.');
		// No transcript is handed over, so the chapters are cut from the
		// lines the note holds now, the recovered one among them.
		expect(generate).toHaveBeenCalledWith(world.audio, undefined);
		const source = await loadTranscriptLines(
			world.app,
			world.audio,
			world.store,
		);
		expect(source?.lines.map((line) => line.text)).toEqual([
			'0:05 the opening',
			'1:05 the middle',
			'2:05 the closing',
		]);
	});
});
