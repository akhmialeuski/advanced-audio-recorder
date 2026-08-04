/**
 * End-to-end regression for renaming speakers in a note an LLM cleanup pass
 * post-processed, with no mocked seams between the pieces: a real diarized
 * `TranscriptionService` run renders the transcript, a real cleanup step
 * rewrites its prose the way the shipped prompt demands (speaker labels and
 * timestamps kept on their original lines), the Markdown lands in a real note
 * through the real insertion path, a real `RecordingSidecarStore` records that
 * note output, and the real `SpeakerRenameModal` then applies names to it.
 *
 * A recorded note used to be refused outright whenever the run had enabled a
 * cleanup or custom pass, on the assumption that such a pass replaces the
 * transcript body. The shipped cleanup prompt asks for the opposite, so the
 * assumption silently cost every user of that combination their rename: the
 * sidecar roster took the names while the note kept reading "Speaker 1". Only
 * a test that renders, cleans, inserts, records, and renames through the real
 * objects catches that, which is why this drives the whole chain.
 * @jest-environment jsdom
 */

import { MarkdownView } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { transcribeFile } from 'src/transcription/runTranscription';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';

/** Internal surface the test drives, mirroring the dialog's unit suite. */
interface ModalInternals {
	render(): Promise<void>;
	apply(): Promise<void>;
	inputs: Map<string, HTMLInputElement>;
}

const NOTE_PATH = 'meetings/standup.md';
const AUDIO_PATH = 'audio/standup.webm';
const SIDECAR_PATH = 'audio/standup.webm.markers.json';

const audioFile = {
	name: 'standup.webm',
	extension: 'webm',
	path: AUDIO_PATH,
} as unknown as TFile;

/** Three turns across two speakers, so both labels reach the note. */
const segments: TranscriptSegment[] = [
	{
		start: 3,
		end: 9.5,
		text: 'morning all lets start',
		speaker: 'Speaker 1',
	},
	{ start: 10, end: 14, text: 'api is done', speaker: 'Speaker 2' },
	{ start: 20, end: 24, text: 'nothing from me', speaker: 'Speaker 1' },
];

/** A TFile-like handle for an in-memory path. */
function tf(path: string): TFile {
	const name = path.split('/').pop() ?? path;
	const dot = name.lastIndexOf('.');
	return {
		path,
		name,
		basename: dot >= 0 ? name.slice(0, dot) : name,
		extension: dot >= 0 ? name.slice(dot + 1) : '',
	} as unknown as TFile;
}

/**
 * Derives a note's link cache the way Obsidian does, by scanning its lines for
 * `[[target#subpath|label]]` references. Building it from the real note text
 * keeps the scoping honest: whatever the cleanup pass did to a line is exactly
 * what the rename sees.
 */
function linkCache(content: string): {
	links: {
		link: string;
		position: { start: { line: number }; end: { line: number } };
	}[];
} {
	const links: {
		link: string;
		position: { start: { line: number }; end: { line: number } };
	}[] = [];
	content.split('\n').forEach((line, index) => {
		const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		let match = pattern.exec(line);
		while (match) {
			links.push({
				link: match[1] ?? '',
				position: { start: { line: index }, end: { line: index } },
			});
			match = pattern.exec(line);
		}
	});
	return { links };
}

/**
 * An App backed by an in-memory file map, shared by the transcription run, the
 * sidecar store, and the dialog. The note is open in a Markdown view whose
 * editor appends at the cursor, which is what the real insertion path needs.
 */
function makeApp(): { app: App; files: Map<string, string> } {
	const files = new Map<string, string>([
		[AUDIO_PATH, ''],
		[NOTE_PATH, '# Standup\n\n![[standup.webm]]\n'],
	]);
	const adapter = {
		exists: (path: string): Promise<boolean> =>
			Promise.resolve(files.has(path)),
		read: (path: string): Promise<string> =>
			Promise.resolve(files.get(path) ?? ''),
		write: (path: string, data: string): Promise<void> => {
			files.set(path, data);
			return Promise.resolve();
		},
		remove: (path: string): Promise<void> => {
			files.delete(path);
			return Promise.resolve();
		},
		rename: (): Promise<void> => Promise.resolve(),
	};
	// Built off the prototype rather than the constructor, so the insertion
	// path's `instanceof MarkdownView` check sees a real view without the
	// workspace leaf the real constructor demands.
	const view = Object.create(MarkdownView.prototype) as {
		file: { path: string };
		editor: {
			getCursor(): { line: number; ch: number };
			replaceRange(text: string, cursor: unknown): void;
		};
	};
	view.file = { path: NOTE_PATH };
	view.editor = {
		// The cursor sits at the end of the note, so the inserted block lands
		// after the existing body just as it does when a user transcribes.
		getCursor: () => ({
			line: (files.get(NOTE_PATH) ?? '').split('\n').length,
			ch: 0,
		}),
		replaceRange: (text: string) => {
			files.set(NOTE_PATH, (files.get(NOTE_PATH) ?? '') + text);
		},
	};
	const app = {
		vault: {
			adapter,
			getFiles: () => [...files.keys()].map((path) => tf(path)),
			getFileByPath: (path: string): TFile | null =>
				files.has(path) ? tf(path) : null,
			read: (file: TFile): Promise<string> =>
				Promise.resolve(files.get(file.path) ?? ''),
			process: (
				file: TFile,
				fn: (data: string) => string,
			): Promise<string> => {
				const next = fn(files.get(file.path) ?? '');
				files.set(file.path, next);
				return Promise.resolve(next);
			},
			getResourcePath: (file: TFile) => `app://vault/${file.path}`,
			readBinary: () => Promise.resolve(new ArrayBuffer(4)),
		},
		fileManager: {
			generateMarkdownLink: (
				file: TFile,
				_notePath: string,
				subpath?: string,
				label?: string,
			) => `[[${file.name}${subpath ?? ''}${label ? `|${label}` : ''}]]`,
		},
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file: TFile) =>
				linkCache(files.get(file.path) ?? ''),
			getFirstLinkpathDest: (linkpath: string): TFile | null => {
				for (const path of files.keys()) {
					if (
						path === linkpath ||
						path.split('/').pop() === linkpath
					) {
						return tf(path);
					}
				}
				return null;
			},
		},
		workspace: {
			getLeavesOfType: (type: string) =>
				type === 'markdown' ? [{ view }] : [],
		},
	} as unknown as App;
	return { app, files };
}

/** A whole-file provider returning the diarized segments untouched. */
function makeProvider(): TranscriptionProvider {
	return {
		id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: true,
			supportsDictionary: true,
			biasChannel: 'prompt',
		},
		transcribe: jest.fn(() => Promise.resolve({ segments })),
	} as unknown as TranscriptionProvider;
}

/**
 * A cleanup LLM that behaves the way DEFAULT_LLM_CLEANUP_PROMPT instructs:
 * the spoken text is repunctuated and capitalized, while every speaker label
 * and timestamp stays byte-for-byte on its original line.
 */
function makeCleanupLlm(): LlmProvider {
	return {
		id: 'openai',
		label: 'Fake cleanup',
		complete: (prompt: { user: string }) =>
			Promise.resolve(
				prompt.user
					.split('\n')
					.map((line) => {
						// Everything up to and including the label plus its
						// separator is the part the prompt tells the model to
						// leave alone; only what follows is repunctuated.
						const spoken =
							/^(.*\*\*Speaker \d+\*\*[^A-Za-z]*)(.+)$/.exec(
								line,
							);
						if (!spoken) {
							return line;
						}
						const text = spoken[2] ?? '';
						return `${spoken[1] ?? ''}${
							text.charAt(0).toUpperCase() + text.slice(1)
						}.`;
					})
					.join('\n'),
			),
	} as unknown as LlmProvider;
}

/** Settings that diarize, write into the note, and run the cleanup pass. */
function cleanupSettings(): AudioRecorderSettings {
	return mergeSettings({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptionDiarize: true,
		transcriptDestination: 'note',
		transcriptTimestampLinks: true,
		transcriptSpeakerFormat: '**{speaker}**',
		transcriptLineFormat: '{timestamp} - {speaker}: {text}',
		llmPostProcessEnabled: true,
		llmPostProcessTask: 'cleanup',
	});
}

/** The transcript section of the sidecar file as it actually sits on disk. */
function storedTranscript(files: Map<string, string>): Record<string, unknown> {
	const raw = files.get(SIDECAR_PATH);
	if (!raw) {
		throw new Error('no sidecar was written');
	}
	return (JSON.parse(raw) as { transcript: Record<string, unknown> })
		.transcript;
}

/** Installs a deterministic audio element as the global Audio factory. */
function installAudio(): { restore(): void } {
	const element = document.createElement('audio');
	Object.defineProperties(element, {
		paused: { configurable: true, get: () => true },
		duration: { configurable: true, get: () => 600 },
		readyState: { configurable: true, get: () => 1 },
	});
	jest.spyOn(element, 'play').mockResolvedValue(undefined);
	jest.spyOn(element, 'pause').mockImplementation(() => undefined);
	jest.spyOn(element, 'load').mockImplementation(() => undefined);
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => element);
	return { restore: () => factory.mockRestore() };
}

describe('renaming speakers in an LLM-cleaned note', () => {
	/** Transcribes once through the real service, store, and insertion path. */
	async function transcribe(
		app: App,
		store: RecordingSidecarStore,
		settings: AudioRecorderSettings,
	): Promise<void> {
		await transcribeFile(
			app,
			() => settings,
			audioFile,
			{ notePathForLinks: NOTE_PATH, sidecar: store },
			{
				createProvider: () => makeProvider(),
				createLlm: () => makeCleanupLlm(),
			},
		);
	}

	/** Opens the real dialog and applies one name per engine label. */
	async function rename(
		app: App,
		store: RecordingSidecarStore,
		settings: AudioRecorderSettings,
		names: Record<string, string>,
	): Promise<void> {
		const modal = new SpeakerRenameModal(app, audioFile, {
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			sidecar: store,
		});
		const internals = modal as unknown as ModalInternals;
		modal.open();
		await internals.render();
		for (const [label, name] of Object.entries(names)) {
			const input = internals.inputs.get(label);
			if (!input) {
				throw new Error(`missing input for ${label}`);
			}
			input.value = name;
		}
		await internals.apply();
		modal.close();
	}

	it('the cleanup pass keeps the rendered labels the rename needs', async () => {
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		await transcribe(app, store, cleanupSettings());

		const note = files.get(NOTE_PATH) ?? '';
		// The pass rewrote the prose but left the timecode link and the
		// rendered label untouched, which is the shape the rename matches on.
		expect(note).toContain(
			'[[standup.webm#t=3|0:03]] - **Speaker 1**: Morning all lets start.',
		);
		expect(note).toContain('**Speaker 2**: Api is done.');
		// The run recorded the note as LLM-post-processed, so the regression
		// path is genuinely exercised rather than sidestepped.
		const recorded = storedTranscript(files).noteOutputs;
		expect(recorded).toEqual([
			expect.objectContaining({ path: NOTE_PATH, llmProcessed: true }),
		]);
	});

	it('applies the names to that note, not only to the sidecar roster', async () => {
		const audio = installAudio();
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		const settings = cleanupSettings();
		await transcribe(app, store, settings);

		await rename(app, store, settings, {
			'Speaker 1': 'Kseniya',
			'Speaker 2': 'Anatol',
		});

		const note = files.get(NOTE_PATH) ?? '';
		expect(note).toContain('**Kseniya**: Morning all lets start.');
		expect(note).toContain('**Anatol**: Api is done.');
		expect(note).toContain('**Kseniya**: Nothing from me.');
		expect(note).not.toContain('**Speaker 1**');
		expect(note).not.toContain('**Speaker 2**');
		// The roster and the note agree, which is the invariant that broke.
		expect(storedTranscript(files).speakers).toEqual([
			expect.objectContaining({ label: 'Speaker 1', name: 'Kseniya' }),
			expect.objectContaining({ label: 'Speaker 2', name: 'Anatol' }),
		]);
		audio.restore();
	});

	it('leaves another recording in the same note alone', async () => {
		const audio = installAudio();
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		const settings = cleanupSettings();
		await transcribe(app, store, settings);
		// A second meeting's transcript shares the note; its labels resolve to
		// a different audio file and must survive this rename untouched.
		files.set('audio/other.webm', '');
		files.set(
			NOTE_PATH,
			`${files.get(NOTE_PATH) ?? ''}\n[[other.webm#t=9|0:09]] - **Speaker 1**: Other meeting.\n`,
		);

		await rename(app, store, settings, { 'Speaker 1': 'Kseniya' });

		const note = files.get(NOTE_PATH) ?? '';
		expect(note).toContain('**Kseniya**: Morning all lets start.');
		expect(note).toContain(
			'[[other.webm#t=9|0:09]] - **Speaker 1**: Other meeting.',
		);
		audio.restore();
	});
});
