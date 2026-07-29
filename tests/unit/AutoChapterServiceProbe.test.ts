/**
 * Covers the parts of AutoChapterService the main suite injects around: the
 * existing-chapter check the on-demand dialog gates its warning on, the real
 * media-metadata duration probe, and the discovery path that finds a
 * transcript among the recording's outputs. The probe matters because the
 * recording's true length is what keeps a generated chapter from landing past
 * the end of a trimmed file - the "last chapter shows 0:00" symptom.
 * @module tests/unit/AutoChapterServiceProbe.test
 */

import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { AUTO_CHAPTER_ID_PREFIX } from 'src/chapters/chapterGeneration';
import { loadTranscriptLines } from 'src/chapters/transcriptSources';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { App, TFile } from 'obsidian';
import { at, defined } from '../helpers/assertions';

jest.mock('src/chapters/transcriptSources', () => ({
	...jest.requireActual<typeof import('src/chapters/transcriptSources')>(
		'src/chapters/transcriptSources',
	),
	loadTranscriptLines: jest.fn(),
}));

const mockLoadTranscriptLines = loadTranscriptLines as jest.MockedFunction<
	typeof loadTranscriptLines
>;

const file = { path: 'Recordings/talk.webm', name: 'talk.webm' } as TFile;

/** A marker store over a fixed marker list, recording what was written. */
interface StoreDouble {
	store: RecordingSidecarStore;
	written: () => PlayerMarker[] | null;
}

/** Builds a marker store double; an Error makes reads reject. */
function makeStore(markers: PlayerMarker[] | Error): StoreDouble {
	const initial = markers instanceof Error ? [] : markers;
	let written: PlayerMarker[] | null = null;
	const store = {
		getMarkers: jest.fn(() =>
			markers instanceof Error
				? Promise.reject(markers)
				: Promise.resolve(initial),
		),
		updateMarkers: jest.fn(
			(
				_path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				written = [...change(initial)];
				return Promise.resolve(written);
			},
		),
	} as unknown as RecordingSidecarStore;
	return { store, written: () => written };
}

/** An LLM returning fixed JSON. */
function makeLlm(output: string): LlmProvider {
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Fake',
		complete: jest.fn(() => Promise.resolve(output)),
	};
}

const settings = {
	llmMaxTokens: 4096,
	transcriptionLanguage: 'auto',
	transcriptionChapterPromptProfiles: [],
	transcriptionChapterPromptProfileId: '',
} as unknown as AudioRecorderSettings;

describe('AutoChapterService.hasExistingChapters', () => {
	it('reports true when a generated chapter is already stored', async () => {
		const service = new AutoChapterService(
			{} as App,
			() => settings,
			makeStore([
				{
					id: `${AUTO_CHAPTER_ID_PREFIX}1`,
					kind: MARKER_KIND.chapter,
					time: 0,
					label: 'Intro',
				},
			]).store,
		);

		expect(await service.hasExistingChapters(file)).toBe(true);
	});

	it('reports false when only manual markers exist', async () => {
		const service = new AutoChapterService(
			{} as App,
			() => settings,
			makeStore([
				{
					id: 'manual-1',
					kind: MARKER_KIND.chapter,
					time: 0,
					label: 'Mine',
				},
			]).store,
		);

		// Regenerating over hand-made chapters needs no warning: they survive.
		expect(await service.hasExistingChapters(file)).toBe(false);
	});

	it('reports false rather than blocking the flow when the sidecar cannot be read', async () => {
		const service = new AutoChapterService(
			{} as App,
			() => settings,
			makeStore(new Error('sidecar corrupt')).store,
		);

		expect(await service.hasExistingChapters(file)).toBe(false);
	});
});

describe('AutoChapterService duration probe', () => {
	/** An Audio element fake that plays back a scripted metadata load. */
	class FakeAudio {
		static last: FakeAudio | null = null;
		preload = '';
		duration = Number.NaN;
		src = '';
		private listeners = new Map<string, (() => void)[]>();
		constructor() {
			FakeAudio.last = this;
		}
		addEventListener(type: string, handler: () => void): void {
			this.listeners.set(type, [
				...(this.listeners.get(type) ?? []),
				handler,
			]);
		}
		removeAttribute(): void {
			/* mirrors the teardown the probe performs */
		}
		load(): void {
			/* mirrors the teardown the probe performs */
		}
		emit(type: string): void {
			for (const handler of this.listeners.get(type) ?? []) {
				handler();
			}
		}
	}

	const originalAudio = global.Audio;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
		FakeAudio.last = null;
		global.Audio = FakeAudio as unknown as typeof Audio;
	});

	afterEach(() => {
		jest.useRealTimers();
		global.Audio = originalAudio;
	});

	/**
	 * Lets the awaits before the probe settle. Fake timers are installed, so a
	 * timer-based flush would deadlock; microtask ticks are enough because
	 * everything between generate() and the probe is already-resolved promises.
	 */
	async function untilProbeStarted(): Promise<FakeAudio> {
		for (let tick = 0; tick < 10 && !FakeAudio.last; tick++) {
			await Promise.resolve();
		}
		return defined(FakeAudio.last, 'audio element');
	}

	/** A service using the real probe against a resource-path app. */
	function makeService(llm: LlmProvider): {
		service: AutoChapterService;
		written: () => PlayerMarker[] | null;
	} {
		const { store, written } = makeStore([]);
		const app = {
			vault: { getResourcePath: () => 'app://talk.webm' },
		} as unknown as App;
		const service = new AutoChapterService(
			app,
			() => settings,
			store,
			undefined,
			{
				createLlm: () => llm,
			},
		);
		return { service, written };
	}

	it('bounds generation by the probed media duration', async () => {
		const llm = makeLlm(
			JSON.stringify({
				chapters: [
					{ time: 0, title: 'Intro' },
					{ time: 400, title: 'Past the end' },
				],
			}),
		);
		const { service, written: writtenMarkers } = makeService(llm);
		const generated = service.generate(file, undefined, {
			origin: 'talk.transcript.json',
			lines: [
				{ time: 0, text: 'intro talk' },
				{ time: 120, text: 'main topic' },
				{
					time: 400,
					text: 'trailing line from an untrimmed transcript',
				},
			],
		});

		// The metadata load answers with a recording shorter than the transcript
		// extent, which is exactly the trimmed-recording case.
		const audio = await untilProbeStarted();
		expect(audio.preload).toBe('metadata');
		expect(audio.src).toBe('app://talk.webm');
		audio.duration = 200;
		audio.emit('loadedmetadata');

		expect(await generated).toBe(true);
		const written = defined(writtenMarkers()).filter((marker) =>
			marker.id.startsWith(AUTO_CHAPTER_ID_PREFIX),
		);
		// The chapter the model invented past the real end is dropped rather
		// than written at a time the player cannot reach.
		expect(written.map((marker) => marker.time)).toEqual([0]);
	});

	it('falls back to the transcript extent when the metadata load fails', async () => {
		const llm = makeLlm(
			JSON.stringify({ chapters: [{ time: 0, title: 'Intro' }] }),
		);
		const { service } = makeService(llm);
		const generated = service.generate(file, undefined, {
			origin: 'talk.transcript.json',
			lines: [{ time: 0, text: 'intro talk' }],
		});

		(await untilProbeStarted()).emit('error');

		// An unreadable duration must not abort generation.
		expect(await generated).toBe(true);
	});

	it('gives up on a metadata load that never resolves', async () => {
		const llm = makeLlm(
			JSON.stringify({ chapters: [{ time: 0, title: 'Intro' }] }),
		);
		const { service } = makeService(llm);
		const generated = service.generate(file, undefined, {
			origin: 'talk.transcript.json',
			lines: [{ time: 0, text: 'intro talk' }],
		});
		await untilProbeStarted();

		jest.advanceTimersByTime(15000);

		// Without the timeout a stalled element would hang the run forever.
		expect(await generated).toBe(true);
	});

	it('ignores a non-finite reported duration', async () => {
		const llm = makeLlm(
			JSON.stringify({ chapters: [{ time: 0, title: 'Intro' }] }),
		);
		const { service } = makeService(llm);
		const generated = service.generate(file, undefined, {
			origin: 'talk.transcript.json',
			lines: [{ time: 0, text: 'intro talk' }],
		});

		const audio = await untilProbeStarted();
		audio.duration = Number.POSITIVE_INFINITY;
		audio.emit('loadedmetadata');

		// A streaming container reports Infinity; treating that as the length
		// would make every chapter fall "inside" the recording.
		expect(await generated).toBe(true);
	});
});

describe('AutoChapterService transcript discovery', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('generates from a transcript found among the recording outputs', async () => {
		mockLoadTranscriptLines.mockResolvedValue({
			origin: 'talk.transcript.json',
			lines: [
				{ time: 0, text: 'intro talk' },
				{ time: 120, text: 'main topic' },
			],
			language: 'de',
		});
		const llm = makeLlm(
			JSON.stringify({
				chapters: [
					{ time: 0, title: 'Einleitung' },
					{ time: 120, title: 'Hauptteil' },
				],
			}),
		);
		const service = new AutoChapterService(
			{} as App,
			() => settings,
			makeStore([]).store,
			undefined,
			{ createLlm: () => llm, probeDuration: () => Promise.resolve(300) },
		);

		expect(await service.generate(file)).toBe(true);
		// The sidecar's language rides along, so the titles are requested in the
		// transcript's language rather than left to the model to guess.
		const call = at((llm.complete as jest.Mock).mock.calls, 0) as [
			{ system: string },
		];
		expect(at(call, 0).system).toContain('de');
	});

	it('stops with guidance when no transcript output exists', async () => {
		mockLoadTranscriptLines.mockResolvedValue(null);
		const llm = makeLlm('{}');
		const service = new AutoChapterService(
			{} as App,
			() => settings,
			makeStore([]).store,
			undefined,
			{ createLlm: () => llm },
		);

		expect(await service.generate(file)).toBe(false);
		// Nothing to chapter means no paid request.
		expect(llm.complete).not.toHaveBeenCalled();
	});
});
