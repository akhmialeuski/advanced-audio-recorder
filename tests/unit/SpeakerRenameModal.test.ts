/**
 * Tests for the manual speaker rename dialog: the empty state, rendering one
 * field per detected speaker, rejecting a duplicate name, applying renames,
 * and creating and growing a participant profile.
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';
import type { SpeakerRenameSidecarAccess } from 'src/ui/SpeakerRenameModal';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	emptyTranscriptSection,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
import {
	applySpeakerRenamesToVault,
	applySpeakerRenamesWithSidecar,
	hasUnscopableRecordedNote,
	inspectAudioTranscript,
} from 'src/speakers/applySpeakerRenames';

jest.mock('src/speakers/applySpeakerRenames', () => ({
	inspectAudioTranscript: jest.fn(),
	applySpeakerRenamesToVault: jest.fn(),
	applySpeakerRenamesWithSidecar: jest.fn(),
	hasUnscopableRecordedNote: jest.fn(),
}));

const inspectMock = inspectAudioTranscript as jest.Mock;
const applyMock = applySpeakerRenamesToVault as jest.Mock;
const sidecarApplyMock = applySpeakerRenamesWithSidecar as jest.Mock;
const unscopableMock = hasUnscopableRecordedNote as jest.Mock;

/** Internal surface the tests drive directly. */
interface ModalInternals {
	render(): Promise<void>;
	apply(): Promise<void>;
	undo(): Promise<void>;
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

function makeModal(
	settings: AudioRecorderSettings,
	sidecar?: SpeakerRenameSidecarAccess,
): {
	modal: SpeakerRenameModal;
	internals: ModalInternals;
	saveSettings: jest.Mock;
} {
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const modal = new SpeakerRenameModal(app, audioFile, {
		getSettings: () => settings,
		saveSettings,
		sidecar,
	});
	return {
		modal,
		internals: modal as unknown as ModalInternals,
		saveSettings,
	};
}

/** A sidecar stub whose getTranscript resolves to the given section. */
function makeSidecar(section: TranscriptSection): {
	getTranscript: jest.Mock;
	setSpeakers: jest.Mock;
	pushHistory: jest.Mock;
} {
	return {
		getTranscript: jest.fn().mockResolvedValue(section),
		setSpeakers: jest.fn().mockResolvedValue(undefined),
		pushHistory: jest.fn().mockResolvedValue(undefined),
	};
}

const cleanApplyResult = {
	updatedNotes: 1,
	updatedTranscriptFiles: 1,
	failed: 0,
	skippedLlmNotes: 0,
	missingOutputs: 0,
};

beforeEach(() => {
	inspectMock.mockReset();
	applyMock.mockReset();
	sidecarApplyMock.mockReset();
	unscopableMock.mockReset();
	applyMock.mockResolvedValue({ ...cleanApplyResult });
	sidecarApplyMock.mockResolvedValue({ ...cleanApplyResult });
	unscopableMock.mockReturnValue(false);
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

describe('SpeakerRenameModal with a sidecar roster', () => {
	/** A section with one named and one unnamed speaker and no outputs. */
	function rosterSection(
		overrides: Partial<TranscriptSection> = {},
	): TranscriptSection {
		return {
			...emptyTranscriptSection(),
			speakers: [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2' },
			],
			...overrides,
		};
	}

	it('prefills the stored names and skips output inspection', async () => {
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(inspectMock).not.toHaveBeenCalled();
		expect(internals.inputs.get('Speaker 1')?.value).toBe('Alex');
		expect(internals.inputs.get('Speaker 2')?.value).toBe('');
	});

	it('falls back to output inspection when the sidecar has no roster', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1'],
			hasUnscopableNote: false,
		});
		const sidecar = makeSidecar(emptyTranscriptSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(inspectMock).toHaveBeenCalled();
		expect(internals.inputs.size).toBe(1);
	});

	it('falls back to output inspection when the sidecar read fails', async () => {
		inspectMock.mockResolvedValue({
			roster: ['Speaker 1'],
			hasUnscopableNote: false,
		});
		const sidecar = makeSidecar(emptyTranscriptSection());
		sidecar.getTranscript.mockRejectedValue(new Error('io error'));
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(1);
		warn.mockRestore();
	});

	it('applies the diff against stored names through the recorded outputs', async () => {
		const section = rosterSection();
		const sidecar = makeSidecar(section);
		const settings = mergeSettings({});
		const { modal, internals } = makeModal(settings, sidecar);
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		const second = internals.inputs.get('Speaker 2');
		if (!first || !second) {
			throw new Error('missing inputs');
		}
		first.value = 'Bob';
		second.value = 'Cleo';
		await internals.apply();

		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1', name: 'Bob' },
			{ label: 'Speaker 2', name: 'Cleo' },
		]);
		expect(sidecar.pushHistory).toHaveBeenCalledWith('audio/rec.wav', {
			'Speaker 1': 'Bob',
			'Speaker 2': 'Cleo',
		});
		// The note shows "Alex" (the stored name), so the rename goes from
		// it, not from the engine label; the unnamed speaker renames from its
		// label. The rewrite runs through the recorded outputs.
		expect(sidecarApplyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[
				{ from: 'Alex', to: 'Bob' },
				{ from: 'Speaker 2', to: 'Cleo' },
			],
			settings.transcriptSpeakerFormat,
			{ allowBroad: false },
		);
		expect(applyMock).not.toHaveBeenCalled();
	});

	it('clearing a prefilled name reverts the speaker to its label', async () => {
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = '';
		await internals.apply();

		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1' },
			{ label: 'Speaker 2' },
		]);
		expect(sidecar.pushHistory).toHaveBeenCalledWith('audio/rec.wav', {});
		expect(sidecarApplyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Alex', to: 'Speaker 1' }],
			expect.any(String),
			{ allowBroad: false },
		);
	});

	it('does nothing when the entered names equal the stored ones', async () => {
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.apply();

		expect(sidecar.setSpeakers).not.toHaveBeenCalled();
		expect(sidecarApplyMock).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith('No speaker names to change.');
	});

	it('reports LLM-skipped notes in the outcome notice', async () => {
		sidecarApplyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			skippedLlmNotes: 1,
		});
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Bob';
		await internals.apply();

		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				'1 note(s) were post-processed by an LLM and were not updated',
			),
		);
	});

	it('offers undo only when the history has entries', async () => {
		const withHistory = makeSidecar(
			rosterSection({
				history: [{ at: 't1', names: { 'Speaker 1': 'Alex' } }],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), withHistory);
		modal.open();
		await internals.render();
		expect(modal.contentEl.textContent).toContain('Undo last rename');

		const without = makeModal(
			mergeSettings({}),
			makeSidecar(rosterSection()),
		);
		without.modal.open();
		await without.internals.render();
		expect(without.modal.contentEl.textContent).not.toContain(
			'Undo last rename',
		);
	});

	it('undo reverts to the second-newest history state and records it', async () => {
		const section = rosterSection({
			speakers: [{ label: 'Speaker 1', name: 'Bob' }],
			history: [
				{ at: 't1', names: { 'Speaker 1': 'Alex' } },
				{ at: 't2', names: { 'Speaker 1': 'Bob' } },
			],
		});
		const sidecar = makeSidecar(section);
		const settings = mergeSettings({});
		const { modal, internals } = makeModal(settings, sidecar);
		modal.open();
		await internals.render();
		await internals.undo();

		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1', name: 'Alex' },
		]);
		expect(sidecar.pushHistory).toHaveBeenCalledWith('audio/rec.wav', {
			'Speaker 1': 'Alex',
		});
		expect(sidecarApplyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[{ from: 'Bob', to: 'Alex' }],
			settings.transcriptSpeakerFormat,
			{ allowBroad: false },
		);
	});

	it('undo of the only apply reverts to the original labels', async () => {
		const section = rosterSection({
			history: [{ at: 't1', names: { 'Speaker 1': 'Alex' } }],
		});
		const sidecar = makeSidecar(section);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.undo();

		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1' },
			{ label: 'Speaker 2' },
		]);
		expect(sidecar.pushHistory).toHaveBeenCalledWith('audio/rec.wav', {});
		expect(sidecarApplyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[{ from: 'Alex', to: 'Speaker 1' }],
			expect.any(String),
			{ allowBroad: false },
		);
	});
});
