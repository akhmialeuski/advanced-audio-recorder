/**
 * Tests for the auto-chapter orchestration: the transcript check, the LLM
 * round-trip, marker persistence (replacing only auto chapters), player
 * refresh, and error containment via Notices.
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { AUTO_CHAPTER_ID_PREFIX } from 'src/chapters/chapterGeneration';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';

const tf = (path: string): TFile => {
	const name = path.split('/').pop() ?? path;
	return partial<TFile>({ path, name });
};

const TRANSCRIPT: Transcript = {
	language: 'en',
	segments: [
		{ start: 0, end: 30, text: 'intro talk', speaker: 'Speaker 1' },
		{ start: 60, end: 200, text: 'main topic', speaker: 'Speaker 2' },
	],
	speakers: ['Speaker 1', 'Speaker 2'],
};

function makeStore(initial: PlayerMarker[] = []): {
	store: RecordingSidecarStore;
	saved: () => PlayerMarker[] | null;
} {
	let written: PlayerMarker[] | null = null;
	const store = partial<RecordingSidecarStore>({
		getMarkers: jest.fn(async () => initial),
		getTranscript: jest.fn(async () => ({
			speakers: [],
			noteOutputs: [],
			fileOutputs: [],
			history: [],
		})),
		updateMarkers: jest.fn(
			async (
				_path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				written = [...change(initial)];
				return written;
			},
		),
	});
	return { store, saved: () => written };
}

function makeLlm(output: string | Error): LlmProvider {
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Fake',
		complete: jest.fn(async () => {
			if (output instanceof Error) {
				throw output;
			}
			return output;
		}),
	};
}

function makeService(options: {
	llm: LlmProvider;
	store: RecordingSidecarStore;
	onWritten?: (path: string) => void;
	app?: App;
	settings?: Partial<AudioRecorderSettings>;
	probeDuration?: () => Promise<number | null>;
}): AutoChapterService {
	const app =
		options.app ??
		createMockApp({
			vault: { getFiles: () => [] },
			metadataCache: { resolvedLinks: {} },
		}).app;
	return new AutoChapterService(
		app,
		() =>
			partial<AudioRecorderSettings>({
				llmMaxTokens: 4096,
				transcriptionLanguage: 'auto',
				transcriptionChapterPromptProfiles: [],
				transcriptionChapterPromptProfileId: '',
				...options.settings,
			}),
		options.store,
		options.onWritten,
		{
			createLlm: () => options.llm,
			probeDuration:
				options.probeDuration ?? (() => Promise.resolve(null)),
		},
	);
}

/** The system prompt handed to the LLM on the first (only) request. */
function requestedSystemPrompt(llm: LlmProvider): string {
	const call = (llm.complete as jest.Mock).mock.calls[0] as [
		{ system: string; user: string },
	];
	return call[0].system;
}

/** A transcript with no detected language (the diarizer returned none). */
const TRANSCRIPT_NO_LANGUAGE: Transcript = {
	segments: [
		{ start: 0, end: 30, text: 'intro talk' },
		{ start: 60, end: 200, text: 'main topic' },
	],
	speakers: [],
};

beforeEach(() => {
	jest.mocked(Notice).mockClear();
});

function noticeTexts(): string[] {
	return jest.mocked(Notice).mock.calls.map((call) => call[0] as string);
}

describe('AutoChapterService.generate', () => {
	it('writes validated chapters from the in-memory transcript and notifies', async () => {
		const llm = makeLlm(
			'[{"time": 0, "title": "Intro"}, {"time": 60, "title": "Main topic"}]',
		);
		const { store, saved } = makeStore();
		const refreshed: string[] = [];
		const service = makeService({
			llm,
			store,
			onWritten: (path) => refreshed.push(path),
		});

		const ok = await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(ok).toBe(true);
		const markers = saved();
		expect(markers?.map((m) => m.label)).toEqual(['Intro', 'Main topic']);
		expect(
			markers?.every(
				(m) =>
					m.kind === MARKER_KIND.chapter &&
					m.id.startsWith(AUTO_CHAPTER_ID_PREFIX),
			),
		).toBe(true);
		expect(refreshed).toEqual(['rec.wav']);
		expect(noticeTexts().some((t) => t.includes('Added 2 chapters'))).toBe(
			true,
		);
	});

	it('uses preloaded transcript lines without re-reading the recording', async () => {
		const llm = makeLlm(
			'[{"time": 0, "title": "Intro"}, {"time": 60, "title": "Main topic"}]',
		);
		const { store, saved } = makeStore();
		// An app with no sidecars and no referencing notes: if the service fell
		// back to loadTranscriptLines it would find nothing and refuse to run.
		const service = makeService({ llm, store });

		const ok = await service.generate(tf('rec.wav'), undefined, {
			lines: [
				{ time: 0, text: 'intro talk' },
				{ time: 60, text: 'main topic' },
			],
			origin: 'rec.json',
			language: 'en',
		});

		expect(ok).toBe(true);
		expect(saved()?.map((m) => m.label)).toEqual(['Intro', 'Main topic']);
		// The preloaded language reaches the prompt.
		expect(requestedSystemPrompt(llm)).toContain(
			'transcript language is en',
		);
	});

	it('replaces old auto chapters but keeps manual markers', async () => {
		const manual: PlayerMarker = {
			id: 'manual',
			time: 500,
			label: 'Manual',
			kind: MARKER_KIND.chapter,
		};
		const oldAuto: PlayerMarker = {
			id: `${AUTO_CHAPTER_ID_PREFIX}old`,
			time: 10,
			label: 'Old',
			kind: MARKER_KIND.chapter,
		};
		const llm = makeLlm('[{"time": 0, "title": "New"}]');
		const { store, saved } = makeStore([manual, oldAuto]);
		const service = makeService({ llm, store });

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(saved()?.map((m) => m.label)).toEqual(['New', 'Manual']);
	});

	it('refuses to run without a transcript and says to transcribe first', async () => {
		const llm = makeLlm('[]');
		const { store, saved } = makeStore();
		const service = makeService({ llm, store });

		const ok = await service.generate(tf('rec.wav'));

		expect(ok).toBe(false);
		expect(saved()).toBeNull();
		expect(llm.complete).not.toHaveBeenCalled();
		expect(
			noticeTexts().some((t) => t.includes('Transcribe the audio first')),
		).toBe(true);
	});

	it('reports unusable LLM output without touching markers', async () => {
		const llm = makeLlm('sorry, I cannot do that');
		const { store, saved } = makeStore();
		const service = makeService({ llm, store });

		const ok = await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(ok).toBe(false);
		expect(saved()).toBeNull();
		expect(
			noticeTexts().some((t) => t.includes('no usable chapters')),
		).toBe(true);
	});

	it('contains provider errors as a failure Notice', async () => {
		const llm = makeLlm(new Error('Set the OpenAI API key in settings.'));
		const { store, saved } = makeStore();
		const service = makeService({ llm, store });

		const ok = await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(ok).toBe(false);
		expect(saved()).toBeNull();
		expect(
			noticeTexts().some((t) =>
				t.includes(
					'Chapter generation failed: Set the OpenAI API key in settings.',
				),
			),
		).toBe(true);
	});

	it("requests titles in the transcript's own language", async () => {
		const llm = makeLlm('[{"time": 0, "title": "Intro"}]');
		const { store } = makeStore();
		const service = makeService({ llm, store });

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(requestedSystemPrompt(llm)).toContain(
			'The transcript language is en',
		);
	});

	it('falls back to the configured language when the transcript has none', async () => {
		const llm = makeLlm('[{"time": 0, "title": "Intro"}]');
		const { store } = makeStore();
		const service = makeService({
			llm,
			store,
			settings: { transcriptionLanguage: 'ru' },
		});

		await service.generate(tf('rec.wav'), TRANSCRIPT_NO_LANGUAGE);

		expect(requestedSystemPrompt(llm)).toContain(
			'The transcript language is ru',
		);
	});

	it('leaves the language to the model when set to auto and none is known', async () => {
		const llm = makeLlm('[{"time": 0, "title": "Intro"}]');
		const { store } = makeStore();
		const service = makeService({
			llm,
			store,
			settings: { transcriptionLanguage: 'auto' },
		});

		await service.generate(tf('rec.wav'), TRANSCRIPT_NO_LANGUAGE);

		const system = requestedSystemPrompt(llm);
		expect(system).toContain(
			'Write the titles in the same language as the transcript',
		);
		expect(system).not.toContain('The transcript language is');
	});

	it('applies the selected chapter guidance profile to the prompt', async () => {
		const llm = makeLlm('[{"time": 0, "title": "Intro"}]');
		const { store } = makeStore();
		const service = makeService({
			llm,
			store,
			settings: {
				transcriptionChapterPromptProfiles: [
					{
						id: 'p',
						name: 'Agenda',
						prompt: 'Split by agenda item.',
					},
				],
				transcriptionChapterPromptProfileId: 'p',
			},
		});

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(requestedSystemPrompt(llm)).toContain('Split by agenda item.');
	});

	it('enforces a minimum chapter gap on bunched model output', async () => {
		const llm = makeLlm(
			'[{"time": 0, "title": "A"}, {"time": 3, "title": "B"}, ' +
				'{"time": 60, "title": "C"}]',
		);
		const { store, saved } = makeStore();
		const service = makeService({ llm, store });

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		// TRANSCRIPT ends at 200s, so the 20-second minimum applies and the
		// 3-second chapter is dropped as too close to the first.
		expect(saved()?.map((m) => m.time)).toEqual([0, 60]);
	});

	it("tells the model the recording's length", async () => {
		const llm = makeLlm(
			'[{"time": 0, "title": "A"}, {"time": 60, "title": "B"}]',
		);
		const { store } = makeStore();
		const service = makeService({ llm, store });

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		// TRANSCRIPT's last segment ends at 200 seconds, which is 3:20.
		expect(requestedSystemPrompt(llm)).toContain('3:20');
	});

	it('drops chapters the model invents past the end of the transcript', async () => {
		const llm = makeLlm(
			'[{"time": 0, "title": "Intro"}, {"time": 9999, "title": "Invented"}]',
		);
		const { store, saved } = makeStore();
		const service = makeService({ llm, store });

		await service.generate(tf('rec.wav'), TRANSCRIPT);

		expect(saved()?.map((m) => m.label)).toEqual(['Intro']);
	});
});
