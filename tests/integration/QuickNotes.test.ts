/**
 * A quick note end to end: the real controller opens the real in-memory
 * recorder, hands the clip to the real transcription service's dictation run,
 * and inserts the text through the real note inserter. Only the browser, the
 * engines, and the workspace are doubles, so a test fails when the pieces stop
 * agreeing with each other, not only when one of them changes.
 * @module tests/integration/QuickNotes.test
 */

import type { App } from 'obsidian';
import { QuickNoteController } from 'src/quicknotes/QuickNoteController';
import { MemoryRecorder } from 'src/recording/MemoryRecorder';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import { SessionCostTracker } from 'src/transcription/SessionCostTracker';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import {
	createProfile,
	ProfileKindId,
	setSelectedProfileId,
} from 'src/settings/profiles';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { RecordingStatus } from 'src/types';
import { EngineLabel } from 'src/providers/providers';
import { noticeMessages } from '../mocks/obsidian';
import { InputLevelMonitor } from 'src/recording/InputLevelMonitor';
import type { MockInputLevelMonitor } from '../mocks/modules/inputLevelMonitor';
import {
	createFile,
	createMarkdownView,
	createMockApp,
	type SpiedMarkdownView,
} from '../helpers/createApp';
import { fakeProvider, type FakeProvider } from '../helpers/providerFixtures';
import { completed } from '../helpers/llmDoubles';
import { partial, silenceConsole } from '../helpers/doubles';
import { at } from '../helpers/assertions';
import {
	ChunkingMediaRecorder,
	type InstalledMicrophone,
	installMicrophone,
} from '../helpers/memoryCapture';

// jsdom has no AudioContext, so the meter is the shared double; the level
// maths is covered by the monitor's own suite.
jest.mock('src/recording/InputLevelMonitor', () =>
	require('../mocks/modules/inputLevelMonitor'),
);

/** What the dictation says, as the engine returns it in two segments. */
const HEARD = 'buy milk and eggs';

/** What the quick note profile turns it into. */
const REWRITTEN = '- Buy milk\n- Buy eggs';

/** The instruction the selected profile carries. */
const LIST_INSTRUCTION = 'Turn the dictation into a bulleted list.';

/** Everything one test drives and observes. */
interface Harness {
	controller: QuickNoteController;
	settings: AudioRecorderSettings;
	provider: FakeProvider;
	llm: { complete: jest.Mock };
	costs: SessionCostTracker;
	statuses: RecordingStatus[];
	/** Every processing stage reported, in order. */
	stages: string[];
	microphone: InstalledMicrophone;
	/** The note the dictation is started in. */
	note: SpiedMarkdownView;
	app: App;
}

/** What a test varies about the world the quick note runs in. */
interface HarnessOptions {
	/** Settings to apply over a vault that transcribes and has quick notes on. */
	settings?: Partial<AudioRecorderSettings>;
	/** Whether a recording session holds the microphone. */
	recordingActive?: boolean;
	/** Markdown views the workspace shows, the first one active. */
	views?: (note: SpiedMarkdownView) => SpiedMarkdownView[];
}

/**
 * Builds the quick note over real components.
 * @param options - What the test varies
 * @returns The harness
 */
function harness(options: HarnessOptions = {}): Harness {
	const microphone = installMicrophone();
	const settings = mergeSettings({
		transcriptionEnabled: true,
		quickNotesEnabled: true,
		whisperApiKey: 'sk-test',
		...options.settings,
	});
	const note = createMarkdownView({
		file: createFile('Notes/today.md'),
		cursor: { line: 3, ch: 5 },
	});
	const views = options.views?.(note) ?? [note];
	const app = createMockApp({
		workspace: {
			getActiveViewOfType: jest.fn(() => views[0] ?? null),
			getLeavesOfType: jest.fn(() => views.map((view) => ({ view }))),
		},
	}).app;
	const provider = fakeProvider({
		transcribe: {
			segments: [
				{ start: 0, end: 2, text: 'buy milk' },
				{ start: 2, end: 4, text: 'and eggs' },
			],
		},
	});
	const llm = {
		complete: jest.fn(async () => completed(REWRITTEN)),
	};
	const costs = new SessionCostTracker();
	const service = new TranscriptionService(app, () => settings, {
		createProvider: () => provider,
		createLlm: () =>
			partial<LlmProvider>({
				id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				label: EngineLabel.OpenAi,
				complete: llm.complete,
			}),
		costSink: costs,
	});
	const statuses: RecordingStatus[] = [];
	const stages: string[] = [];
	const controller = new QuickNoteController({
		app,
		getSettings: () => settings,
		recorder: new MemoryRecorder(),
		dictate: (audio, dictateOptions) =>
			service.dictate(audio, dictateOptions),
		costs,
		recordingActive: () => options.recordingActive ?? false,
		onStatusChange: (status, progress) => {
			statuses.push(status);
			if (progress) {
				stages.push(progress.description);
			}
		},
	});
	return {
		controller,
		settings,
		provider,
		llm,
		costs,
		statuses,
		stages,
		microphone,
		note,
		app,
	};
}

/**
 * Selects a quick note profile carrying the given instruction.
 * @param settings - The settings to add it to
 * @param instruction - The profile's body
 */
function selectQuickNoteProfile(
	settings: AudioRecorderSettings,
	instruction: string,
): void {
	const profile = createProfile(ProfileKindId.QuickNote, 'List', instruction);
	settings.profiles = [...settings.profiles, profile];
	setSelectedProfileId(settings, ProfileKindId.QuickNote, profile.id);
}

/** How a test settles a microphone open it is holding. */
interface HeldOpen {
	/** Opens the microphone, as a granted permission prompt does. */
	grant: () => void;
	/** Fails the open, as a refused permission prompt does. */
	refuse: () => void;
}

/**
 * Holds the next microphone open until the test settles it, the way a
 * permission prompt holds it until the user answers.
 * @param h - The harness whose microphone is held
 * @returns How to settle the open
 */
function holdMicrophoneOpen(h: Harness): HeldOpen {
	let held: HeldOpen = { grant: () => undefined, refuse: () => undefined };
	h.microphone.getUserMedia.mockReturnValueOnce(
		new Promise((resolve, reject) => {
			held = {
				grant: () => {
					resolve(h.microphone.stream);
				},
				refuse: () => {
					reject(new Error('Permission denied'));
				},
			};
		}),
	);
	return held;
}

/**
 * Presses the button twice: once to start dictating, once to stop.
 * @param controller - The quick note under test
 */
async function dictate(controller: QuickNoteController): Promise<void> {
	await controller.toggle();
	await controller.toggle();
}

describe('quick notes', () => {
	it('inserts the dictation as heard at the cursor of the note it started in', async () => {
		const h = harness();

		await dictate(h.controller);

		expect(h.note.editor.replaceSelection).toHaveBeenCalledWith(HEARD);
		// No profile is selected, so the dictation is transcription alone.
		expect(h.llm.complete).not.toHaveBeenCalled();
		expect(h.statuses.at(0)).toBe(RecordingStatus.Recording);
		expect(h.statuses.at(-1)).toBe(RecordingStatus.Idle);
	});

	it('reports what it has recorded while it records, and nothing once stopped', async () => {
		// The status bar shows the elapsed time, the size and the input meter
		// of a dictation the way it shows them for a recording.
		const h = harness();
		await h.controller.toggle();
		const meter = jest.mocked(InputLevelMonitor).mock
			.instances[0] as unknown as MockInputLevelMonitor;
		meter.getLevel.mockReturnValue(0.4);

		expect(h.controller.liveStats()).toEqual({
			elapsedMs: expect.any(Number) as number,
			bytes: 0,
			level: 0.4,
		});

		await h.controller.toggle();

		expect(h.controller.liveStats()).toBeNull();
		expect(meter.stop).toHaveBeenCalledTimes(1);
	});

	it('reports each stage of the processing, the way a recording reports its save', async () => {
		// The status bar reads these; without them the user cannot tell a
		// dictation being transcribed from one that stalled.
		const h = harness();
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);

		await dictate(h.controller);

		expect(h.stages).toEqual([
			'Quick note: stopping...',
			'Quick note: Preparing audio...',
			'Quick note: Transcribing...',
			'Quick note: Rewriting with LLM...',
			'Quick note: Done',
		]);
		expect(new Set(h.statuses)).toEqual(
			new Set([
				RecordingStatus.Recording,
				RecordingStatus.Saving,
				RecordingStatus.Idle,
			]),
		);
	});

	it('sends the recorded audio from memory, in the container it was recorded in', async () => {
		const h = harness();

		await dictate(h.controller);

		const [payload] = at(h.provider.transcribe.mock.calls, 0);
		expect(payload.filename).toBe('quick-note.webm');
		expect(new TextDecoder().decode(payload.data)).toBe('chunk');
		// The microphone is released once the dictation is stopped.
		expect(h.microphone.trackStop).toHaveBeenCalledTimes(1);
	});

	it('asks for plain text: no speakers and no word timings, whatever the transcript settings say', async () => {
		// Speakers and word timings shape a transcript document. A dictation
		// is one person's text for the cursor, so it must not pay for either.
		const h = harness({
			settings: {
				transcriptionDiarize: true,
				transcriptionWordTimestamps: true,
				transcriptionTranslateToEnglish: true,
			},
		});

		await dictate(h.controller);

		const [, options] = at(h.provider.transcribe.mock.calls, 0);
		expect(options.diarize).toBe(false);
		expect(options.wordTimestamps).toBe(false);
		// A dictation is inserted in the language it was spoken in.
		expect(options.translateToEnglish).toBe(false);
	});

	it('leaves the transcript post-processing to recordings', async () => {
		// The cleanup prompt of a recording is not what a dictation asked for;
		// only a quick note profile rewrites one.
		const h = harness({ settings: { llmPostProcessEnabled: true } });

		await dictate(h.controller);

		expect(h.llm.complete).not.toHaveBeenCalled();
		expect(h.note.editor.replaceSelection).toHaveBeenCalledWith(HEARD);
	});

	it('rewrites the dictation with the selected profile before inserting it', async () => {
		const h = harness();
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);

		await dictate(h.controller);

		const [prompt] = at(h.llm.complete.mock.calls, 0) as unknown as [
			{ system: string; user: string },
		];
		expect(prompt).toEqual({ system: LIST_INSTRUCTION, user: HEARD });
		expect(h.note.editor.replaceSelection).toHaveBeenCalledWith(REWRITTEN);
	});

	it('inserts the text as dictated when the rewrite fails, and says so', async () => {
		silenceConsole('warn');
		const h = harness();
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);
		h.llm.complete.mockRejectedValue(new Error('503 upstream'));

		await dictate(h.controller);

		expect(h.note.editor.replaceSelection).toHaveBeenCalledWith(HEARD);
		expect(noticeMessages()).toContain(
			'Quick note rewrite failed; inserting the text as dictated.',
		);
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('records what the dictation cost in the session total', async () => {
		const h = harness();
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);

		await dictate(h.controller);

		// One transcription run and one LLM call. The engine reported no
		// usage and the dictation carries no measured length, so the run is
		// counted as unpriced rather than left out of the total.
		expect(
			h.costs.engineTotals().map((entry) => ({
				engineId: entry.engineId,
				calls: entry.runs + entry.unpricedRuns,
			})),
		).toEqual([
			{ engineId: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE, calls: 1 },
			{ engineId: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, calls: 1 },
		]);
	});

	it('puts the text into the note it started in, when another note became active meanwhile', async () => {
		const other = createMarkdownView({
			file: createFile('Notes/other.md'),
		});
		let active: SpiedMarkdownView | null = null;
		const h = harness({
			views: (note) => {
				active = note;
				return [note, other];
			},
		});
		await h.controller.toggle();
		// The user switched notes while dictating: the one they started in
		// is still open in a background pane.
		active = other;
		jest.mocked(h.app.workspace.getActiveViewOfType).mockImplementation(
			() => active,
		);
		await h.controller.toggle();

		expect(h.note.editor.replaceSelection).toHaveBeenCalledWith(HEARD);
		expect(other.editor.replaceSelection).not.toHaveBeenCalled();
	});

	it('copies the text to the clipboard when no note is open to take it', async () => {
		const writeText = jest.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const h = harness({ views: () => [] });

		await dictate(h.controller);

		expect(writeText).toHaveBeenCalledWith(HEARD);
		expect(noticeMessages()).toContain(
			'No note is open to take the quick note, so its text was copied to the clipboard.',
		);
	});

	it('refuses before opening the microphone when the engine is not set up', async () => {
		const h = harness({ settings: { whisperApiKey: '' } });

		await h.controller.toggle();

		expect(h.microphone.getUserMedia).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
		expect(noticeMessages()).toHaveLength(1);
	});

	it('refuses before opening the microphone when the profile engine is not set up', async () => {
		// A profile that cannot be applied would only be found out after the
		// user finished speaking, so it stops the dictation from starting.
		const h = harness({
			settings: {
				quickNoteLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
				anthropicApiKey: '',
			},
		});
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);

		await h.controller.toggle();

		expect(h.microphone.getUserMedia).not.toHaveBeenCalled();
		expect(h.statuses).toEqual([]);
	});

	it('does not dictate over a recording that holds the microphone', async () => {
		const h = harness({ recordingActive: true });

		await h.controller.toggle();

		expect(h.microphone.getUserMedia).not.toHaveBeenCalled();
		expect(noticeMessages()).toContain(
			'Stop the recording before dictating a quick note.',
		);
	});

	it('answers a press during transcription without starting a second dictation', async () => {
		const h = harness();
		let release: () => void = () => undefined;
		const reached = new Promise<void>((engineCalled) => {
			h.provider.transcribe.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = () => {
							resolve({
								segments: [{ start: 0, end: 1, text: HEARD }],
							});
						};
						engineCalled();
					}),
			);
		});
		await h.controller.toggle();
		const stopping = h.controller.toggle();
		await reached;

		await h.controller.toggle();
		release();
		await stopping;

		expect(noticeMessages()).toContain(
			'The last quick note is still being transcribed.',
		);
		expect(h.microphone.getUserMedia).toHaveBeenCalledTimes(1);
		expect(h.note.editor.replaceSelection).toHaveBeenCalledTimes(1);
	});

	it('inserts nothing once cancelled mid-transcription, and returns to idle', async () => {
		// The plugin unloading, or quick notes switched off, leaves the text
		// nowhere to go.
		const h = harness();
		const reached = new Promise<void>((engineCalled) => {
			h.provider.transcribe.mockImplementation(
				async (_payload, options) =>
					new Promise((_resolve, reject) => {
						options.signal?.addEventListener('abort', () => {
							reject(new Error('aborted'));
						});
						engineCalled();
					}),
			);
		});
		await h.controller.toggle();
		const stopping = h.controller.toggle();
		await reached;

		h.controller.cancel();
		await stopping;

		expect(h.note.editor.replaceSelection).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
		expect(noticeMessages()).not.toContainEqual(
			expect.stringContaining('Quick note failed'),
		);
	});
});

describe('quick notes that go wrong', () => {
	it('says so and stays ready when the microphone cannot be opened', async () => {
		silenceConsole('error');
		const h = harness();
		h.microphone.getUserMedia.mockRejectedValueOnce(
			new Error('Permission denied'),
		);

		await h.controller.toggle();

		expect(noticeMessages()).toEqual([
			'Quick note could not open the microphone: Permission denied',
		]);
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
		// The next press starts a dictation rather than stopping one.
		await h.controller.toggle();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Recording);
	});

	it('names the format when this device cannot record it', async () => {
		const h = harness();
		ChunkingMediaRecorder.isTypeSupported.mockReturnValue(false);

		await h.controller.toggle();

		expect(noticeMessages()).toEqual([
			'Format "webm" cannot be recorded here. Pick another output format.',
		]);
		expect(h.microphone.getUserMedia).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('treats a press during a microphone open that fails as nothing to stop', async () => {
		silenceConsole('error');
		const h = harness();
		const { refuse } = holdMicrophoneOpen(h);

		const starting = h.controller.toggle();
		const stopping = h.controller.toggle();
		refuse();
		await Promise.all([starting, stopping]);

		expect(h.provider.transcribe).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('says the dictation recorded nothing when the recorder delivered no audio', async () => {
		const h = harness();
		ChunkingMediaRecorder.nextChunk = '';

		await dictate(h.controller);

		expect(noticeMessages()).toContain('The quick note recorded no audio.');
		expect(h.provider.transcribe).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('reports a transcription that failed, and inserts nothing', async () => {
		silenceConsole('error');
		const h = harness();
		h.provider.transcribe.mockRejectedValue(new Error('401 bad key'));

		await dictate(h.controller);

		expect(noticeMessages()).toContainEqual(
			expect.stringMatching(/^Quick note failed: .*401 bad key/),
		);
		expect(h.note.editor.replaceSelection).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('says nothing was recognized rather than inserting an empty string', async () => {
		const h = harness();
		h.provider.transcribe.mockResolvedValue({ segments: [] });

		await dictate(h.controller);

		expect(noticeMessages()).toContain(
			'Nothing was recognized in the quick note.',
		);
		expect(h.note.editor.replaceSelection).not.toHaveBeenCalled();
	});

	it('stops quietly when it is cancelled as the second press lands', async () => {
		const h = harness();
		await h.controller.toggle();

		const stopping = h.controller.toggle();
		h.controller.cancel();
		await stopping;

		expect(h.provider.transcribe).not.toHaveBeenCalled();
		// A cancel is not an empty recording and not a failure.
		expect(noticeMessages()).toEqual([]);
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('inserts nothing when cancelled while a rewrite that ignored the cancel was finishing', async () => {
		// A vendor that answers after the abort still hands the text back;
		// the dictation was cancelled, so it has nowhere to go.
		const h = harness();
		selectQuickNoteProfile(h.settings, LIST_INSTRUCTION);
		h.llm.complete.mockImplementation(async () => {
			h.controller.cancel();
			return completed(REWRITTEN);
		});

		await dictate(h.controller);

		expect(h.note.editor.replaceSelection).not.toHaveBeenCalled();
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('transcribes and inserts once, however many presses land while the microphone opens', async () => {
		// Every press after the first one while the permission prompt is up
		// used to stop the same capture again: two runs, two bills, two
		// insertions.
		const h = harness();
		const { grant } = holdMicrophoneOpen(h);

		const presses = [
			h.controller.toggle(),
			h.controller.toggle(),
			h.controller.toggle(),
		];
		grant();
		await Promise.all(presses);

		expect(h.provider.transcribe).toHaveBeenCalledTimes(1);
		expect(h.note.editor.replaceSelection).toHaveBeenCalledTimes(1);
		expect(noticeMessages()).toContain(
			'The last quick note is still being transcribed.',
		);
		expect(h.controller.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('keeps a newer dictation recording when an older, cancelled open settles late', async () => {
		// Switched off and on again during a permission prompt, the old open
		// settles after the new dictation started and must not reset its state.
		const h = harness();
		const { grant: grantOld } = holdMicrophoneOpen(h);
		const oldStart = h.controller.toggle();
		h.controller.cancel();

		await h.controller.toggle();
		grantOld();
		await oldStart;

		expect(h.controller.getStatus()).toBe(RecordingStatus.Recording);
	});

	it('says nothing when a cancelled open fails late, since a newer dictation owns the state', async () => {
		silenceConsole('error');
		const h = harness();
		const { refuse } = holdMicrophoneOpen(h);
		const oldStart = h.controller.toggle();
		h.controller.cancel();

		await h.controller.toggle();
		refuse();
		await oldStart;

		expect(noticeMessages()).toEqual([]);
		expect(h.controller.getStatus()).toBe(RecordingStatus.Recording);
	});

	it('puts the text in front of the user when the clipboard refuses it too', async () => {
		silenceConsole('warn');
		Object.assign(navigator, {
			clipboard: {
				writeText: jest
					.fn()
					.mockRejectedValue(new Error('Document is not focused.')),
			},
		});
		const h = harness({ views: () => [] });

		await dictate(h.controller);

		expect(noticeMessages()).toContain(
			`No note is open to take the quick note, and the clipboard refused it. The text: ${HEARD}`,
		);
		expect(noticeMessages()).not.toContainEqual(
			expect.stringContaining('Quick note failed'),
		);
	});
});
