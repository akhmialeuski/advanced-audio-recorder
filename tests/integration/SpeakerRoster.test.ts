/**
 * End-to-end test of the speaker roster loop, with no mocked seams between the
 * pieces: a real diarized `TranscriptionService` run writes through a real
 * `RecordingSidecarStore` onto a real (in-memory) sidecar file, and the real
 * `SpeakerRenameModal` then reads that same file back.
 *
 * The unit suites each verify one half against a stub, which is exactly how a
 * roster written in one shape and read in another would slip through. This
 * drives the actual JSON: the participants a run carried, the first-turn
 * offsets it measured, the preview those offsets produce, and the name the
 * dialog writes back.
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';
import { internalsOf, partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';

/** Internal surface the test drives, mirroring the dialog's unit suite. */
interface ModalInternals {
	render(): Promise<void>;
	apply(): Promise<void>;
	suggestionPool(): string[];
	inputs: Map<string, HTMLInputElement>;
	previewButtons: Map<string, { buttonEl: HTMLButtonElement }>;
}

const audioFile = partial<TFile>({
	name: 'standup.webm',
	extension: 'webm',
	path: 'audio/standup.webm',
});

/** The sidecar path the store derives for the recording under test. */
const SIDECAR_PATH = 'audio/standup.webm.markers.json';

/**
 * Two speakers, the first talking across two consecutive segments so the
 * measured turn has to span both.
 */
const segments: TranscriptSegment[] = [
	{ start: 3, end: 6, text: 'morning all', speaker: 'Speaker 1' },
	{ start: 6, end: 9.5, text: 'lets start', speaker: 'Speaker 1' },
	{ start: 10, end: 14, text: 'api is done', speaker: 'Speaker 2' },
];

/** An App backed by an in-memory adapter, shared by the store and the dialog. */
function makeApp(): { app: App; files: Map<string, string> } {
	const files = new Map<string, string>();
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
	const app = createMockApp({
		vault: {
			adapter,
			getFiles: () => [...files.keys()].map((path) => ({ path })),
			// No transcript outputs were recorded, so the rename touches no
			// files; the dialog still resolves the recording for playback.
			getFileByPath: () => null,
			getResourcePath: (file: TFile) => `app://vault/${file.path}`,
			readBinary: () => Promise.resolve(new ArrayBuffer(4)),
		},
		fileManager: {
			generateMarkdownLink: (
				_f: unknown,
				_n: unknown,
				_s: unknown,
				label: string,
			) => `[${label}](standup.webm)`,
		},
		metadataCache: { resolvedLinks: {} },
	}).app;
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

/** Settings that diarize and carry a selected participant profile. */
function settingsWithProfile(): AudioRecorderSettings {
	return mergeSettings({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptionDiarize: true,
		transcriptionSpeakerProfiles: [
			{
				id: 'p1',
				name: 'Weekly sync',
				participants: ['Maria', 'Ivan'],
			},
		],
		transcriptionSpeakerProfileId: 'p1',
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
function installAudio(): { element: HTMLAudioElement; restore(): void } {
	const element = document.createElement('audio');
	let currentTime = 0;
	Object.defineProperties(element, {
		paused: { configurable: true, get: () => true },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => 600 },
		// Metadata already available, so a press seeks straight away.
		readyState: { configurable: true, get: () => 1 },
	});
	jest.spyOn(element, 'play').mockResolvedValue(undefined);
	jest.spyOn(element, 'pause').mockImplementation(() => undefined);
	jest.spyOn(element, 'load').mockImplementation(() => undefined);
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => element);
	return { element, restore: () => factory.mockRestore() };
}

describe('speaker roster round trip', () => {
	/** Transcribes once through the real service and real store. */
	async function transcribe(
		app: App,
		store: RecordingSidecarStore,
		settings: AudioRecorderSettings,
	): Promise<void> {
		const service = new TranscriptionService(app, () => settings, {
			createProvider: () => makeProvider(),
		});
		await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar: store,
		});
	}

	it('writes the participants and first-turn offsets into the real sidecar file', async () => {
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		await transcribe(app, store, settingsWithProfile());

		const transcript = storedTranscript(files);
		// The profile's names travel with the recording, tagged with the
		// profile they came from...
		expect(transcript.participants).toEqual(['Maria', 'Ivan']);
		expect(transcript.participantProfileId).toBe('p1');
		// ...and Speaker 1's turn spans both of its consecutive segments.
		expect(transcript.speakers).toEqual([
			{ label: 'Speaker 1', firstStart: 3, firstEnd: 9.5 },
			{ label: 'Speaker 2', firstStart: 10, firstEnd: 14 },
		]);
	});

	it('the dialog reads that file back: suggestions, offsets, and a working preview', async () => {
		const audio = installAudio();
		const { app } = makeApp();
		const store = new RecordingSidecarStore(app);
		const settings = settingsWithProfile();
		await transcribe(app, store, settings);

		// A second store instance, so the dialog genuinely parses the file from
		// disk rather than reading a cache the run left behind.
		const reader = new RecordingSidecarStore(app);
		const modal = new SpeakerRenameModal(app, audioFile, {
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			sidecar: reader,
		});
		const internals = internalsOf<ModalInternals>(modal);
		modal.open();
		await internals.render();

		// The stored profile re-selects itself, so its names suggest.
		expect(internals.suggestionPool()).toEqual(['Maria', 'Ivan']);
		expect(modal.contentEl.textContent).toContain('First speaks at 0:03');
		expect(modal.contentEl.textContent).toContain('First speaks at 0:10');

		// Pressing a row's button plays from the offset the run measured.
		internals.previewButtons.get('Speaker 2')?.buttonEl.click();
		expect(audio.element.currentTime).toBe(10);

		modal.close();
		audio.restore();
	});

	it('a name applied in the dialog is written back into the same file', async () => {
		const audio = installAudio();
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		const settings = settingsWithProfile();
		await transcribe(app, store, settings);

		const modal = new SpeakerRenameModal(app, audioFile, {
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			sidecar: store,
		});
		const internals = internalsOf<ModalInternals>(modal);
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		// A name in neither the recording's roster nor the profile.
		first.value = 'Priya';
		await internals.apply();

		const transcript = storedTranscript(files);
		expect(transcript.participants).toEqual(['Maria', 'Ivan', 'Priya']);
		// The name landed on the roster and the offsets survived the rename.
		expect(transcript.speakers).toEqual([
			{ label: 'Speaker 1', name: 'Priya', firstStart: 3, firstEnd: 9.5 },
			{ label: 'Speaker 2', firstStart: 10, firstEnd: 14 },
		]);
		// The profile learned it too, for the next recording that picks it.
		expect(settings.transcriptionSpeakerProfiles[0]?.participants).toEqual([
			'Maria',
			'Ivan',
			'Priya',
		]);
		audio.restore();
	});

	it('a re-transcription keeps the name and refreshes the offsets', async () => {
		const audio = installAudio();
		const { app, files } = makeApp();
		const store = new RecordingSidecarStore(app);
		const settings = settingsWithProfile();
		await transcribe(app, store, settings);

		const modal = new SpeakerRenameModal(app, audioFile, {
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			sidecar: store,
		});
		const internals = internalsOf<ModalInternals>(modal);
		modal.open();
		await internals.render();
		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Priya';
		await internals.apply();

		await transcribe(app, store, settings);

		const transcript = storedTranscript(files);
		expect(transcript.speakers).toEqual([
			{ label: 'Speaker 1', name: 'Priya', firstStart: 3, firstEnd: 9.5 },
			{ label: 'Speaker 2', firstStart: 10, firstEnd: 14 },
		]);
		// The run re-recorded its profile without dropping the applied name.
		expect(transcript.participants).toEqual(['Maria', 'Ivan', 'Priya']);
		audio.restore();
	});
});
