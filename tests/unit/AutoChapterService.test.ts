/**
 * Tests for the auto-chapter orchestration: the transcript check, the LLM
 * round-trip, marker persistence (replacing only auto chapters), player
 * refresh, and error containment via Notices.
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { AUTO_CHAPTER_ID_PREFIX } from 'src/chapters/chapterGeneration';
import type { MarkerStore } from 'src/markers/MarkerStore';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';

const tf = (path: string): TFile => {
	const name = path.split('/').pop() ?? path;
	return { path, name } as unknown as TFile;
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
	store: MarkerStore;
	saved: () => PlayerMarker[] | null;
} {
	let written: PlayerMarker[] | null = null;
	const store = {
		get: jest.fn(async () => initial),
		set: jest.fn(async (_path: string, markers: PlayerMarker[]) => {
			written = markers;
		}),
	} as unknown as MarkerStore;
	return { store, saved: () => written };
}

function makeLlm(output: string | Error): LlmProvider {
	return {
		id: 'fake',
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
	store: MarkerStore;
	onWritten?: (path: string) => void;
	app?: App;
}): AutoChapterService {
	const app =
		options.app ??
		({
			vault: { getFiles: () => [] },
			metadataCache: { resolvedLinks: {} },
		} as unknown as App);
	return new AutoChapterService(
		app,
		() => ({ llmMaxTokens: 4096 }) as unknown as AudioRecorderSettings,
		options.store,
		options.onWritten,
		{ createLlm: () => options.llm },
	);
}

beforeEach(() => {
	(Notice as unknown as jest.Mock).mockClear();
});

function noticeTexts(): string[] {
	return (Notice as unknown as jest.Mock).mock.calls.map(
		(call) => call[0] as string,
	);
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
