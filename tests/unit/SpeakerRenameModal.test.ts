/**
 * Tests for the manual speaker rename dialog: the empty state, rendering one
 * field per detected speaker, rejecting a duplicate name, applying renames,
 * and creating and growing a participant profile.
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	applySpeakerRenamesToVault,
	inspectAudioTranscript,
} from 'src/speakers/applySpeakerRenames';

jest.mock('src/speakers/applySpeakerRenames', () => ({
	inspectAudioTranscript: jest.fn(),
	applySpeakerRenamesToVault: jest.fn(),
}));

const inspectMock = inspectAudioTranscript as jest.Mock;
const applyMock = applySpeakerRenamesToVault as jest.Mock;

/** Internal surface the tests drive directly. */
interface ModalInternals {
	render(): Promise<void>;
	apply(): Promise<void>;
	createProfile(): Promise<void>;
	inputs: Map<string, HTMLInputElement>;
	selectedProfileId: string;
	allowBroad: boolean;
	newProfileInput: HTMLInputElement | null;
}

const audioFile = {
	name: 'rec.wav',
	path: 'audio/rec.wav',
} as unknown as TFile;

const app = {} as unknown as App;

function makeModal(settings: AudioRecorderSettings): {
	modal: SpeakerRenameModal;
	internals: ModalInternals;
	saveSettings: jest.Mock;
} {
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const modal = new SpeakerRenameModal(app, audioFile, {
		getSettings: () => settings,
		saveSettings,
	});
	return {
		modal,
		internals: modal as unknown as ModalInternals,
		saveSettings,
	};
}

beforeEach(() => {
	inspectMock.mockReset();
	applyMock.mockReset();
	applyMock.mockResolvedValue({
		updatedNotes: 1,
		updatedTranscriptFiles: 1,
		failed: 0,
	});
});

describe('SpeakerRenameModal', () => {
	it('explains when the recording has no diarized transcript', async () => {
		inspectMock.mockResolvedValue({ roster: [], hasUnscopableNote: false });
		const { modal, internals } = makeModal(mergeSettings({}));
		modal.open();
		await internals.render();

		expect(modal.contentEl.textContent).toContain(
			'Transcribe it with speaker diarization first.',
		);
		expect(internals.inputs.size).toBe(0);
	});

	it('renders one empty field per detected speaker', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1', 'Speaker 2'],
			hasUnscopableNote: false,
		});
		const { modal, internals } = makeModal(mergeSettings({}));
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(2);
		expect(internals.inputs.get('Speaker 1')?.value).toBe('');
		expect(internals.inputs.get('Speaker 2')?.placeholder).toBe(
			'Speaker 2',
		);
	});

	it('applies renames scoped, without broad rewrite by default', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1', 'Speaker 2'],
			hasUnscopableNote: false,
		});
		const { modal, internals } = makeModal(mergeSettings({}));
		modal.open();
		await internals.render();

		const input = internals.inputs.get('Speaker 1');
		if (!input) {
			throw new Error('missing input for Speaker 1');
		}
		input.value = ' Alex ';
		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			[{ from: 'Speaker 1', to: 'Alex' }],
			expect.any(String),
			{ allowBroad: false },
		);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				'Renamed speakers in 1 note and 1 transcript file',
			),
		);
	});

	it('rejects assigning one name to two speakers', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1', 'Speaker 2'],
			hasUnscopableNote: false,
		});
		const { modal, internals } = makeModal(mergeSettings({}));
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		const second = internals.inputs.get('Speaker 2');
		if (!first || !second) {
			throw new Error('missing inputs');
		}
		first.value = 'Alex';
		second.value = 'Alex';
		await internals.apply();

		expect(applyMock).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Two speakers cannot share a name'),
		);
	});

	it('passes broad rewrite through when the user opts in', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1'],
			hasUnscopableNote: true,
		});
		const { modal, internals } = makeModal(mergeSettings({}));
		modal.open();
		await internals.render();

		const input = internals.inputs.get('Speaker 1');
		if (!input) {
			throw new Error('missing input');
		}
		input.value = 'Alex';
		internals.allowBroad = true;
		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			[{ from: 'Speaker 1', to: 'Alex' }],
			expect.any(String),
			{ allowBroad: true },
		);
	});

	it('creates a profile and adds applied names to it', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1'],
			hasUnscopableNote: false,
		});
		const settings = mergeSettings({});
		const { modal, internals, saveSettings } = makeModal(settings);
		modal.open();
		await internals.render();

		if (!internals.newProfileInput) {
			throw new Error('missing new-profile input');
		}
		internals.newProfileInput.value = 'Weekly sync';
		await internals.createProfile();

		expect(settings.transcriptionSpeakerProfiles).toHaveLength(1);
		expect(settings.transcriptionSpeakerProfiles[0]?.name).toBe(
			'Weekly sync',
		);
		expect(internals.selectedProfileId).toBe(
			settings.transcriptionSpeakerProfiles[0]?.id,
		);

		const input = internals.inputs.get('Speaker 1');
		if (!input) {
			throw new Error('missing input');
		}
		input.value = 'Alex';
		await internals.apply();

		expect(settings.transcriptionSpeakerProfiles[0]?.participants).toEqual([
			'Alex',
		]);
		expect(saveSettings).toHaveBeenCalled();
	});
});
