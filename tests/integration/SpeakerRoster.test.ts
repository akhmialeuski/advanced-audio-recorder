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
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';
import { fakeProvider } from '../helpers/providerFixtures';
import { installControlledAudio } from '../helpers/mediaMocks';

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
	const { files, adapter } = fakeVaultFiles();
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
/**
 * A whole-file provider returning the diarized segments untouched.
 * @returns The provider double
 */
function makeProvider(): TranscriptionProvider {
	return fakeProvider({
		id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcribe: { segments },
	});
}

/** Settings that diarize and carry a selected participant profile. */
function settingsWithProfile(): AudioRecorderSettings {
	return mergeSettings({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptionDiarize: true,
		profiles: [
			{
				id: 'p1',
				kind: 'participants',
				name: 'Weekly sync',
				body: 'Maria\nIvan',
			},
		],
		selectedProfileIds: { participants: 'p1' },
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

	/**
	 * Transcribes one recording and opens the rename dialog over it, rendered
	 * and ready to type into. Every test here starts from that state; what
	 * they differ on is what they type and what they then read back.
	 * @returns The dialog's internals, the vault's files, and the settings
	 */
	async function openRenameDialog(): Promise<{
		app: App;
		store: RecordingSidecarStore;
		files: Map<string, string>;
		settings: AudioRecorderSettings;
		modal: SpeakerRenameModal;
		internals: ModalInternals;
	}> {
		installControlledAudio({ duration: 600 });
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

		return { app, store, files, settings, modal, internals };
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
		const audio = installControlledAudio({ duration: 600 });
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
		expect(audio.audio.currentTime).toBe(10);

		modal.close();
	});

	it('a name applied in the dialog is written back into the same file', async () => {
		const { files, settings, internals } = await openRenameDialog();

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
		expect(settings.profiles[0]?.body).toBe('Maria\nIvan\nPriya');
	});

	it('a re-transcription keeps the name and refreshes the offsets', async () => {
		const { app, store, files, settings, internals } =
			await openRenameDialog();
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
	});
});
