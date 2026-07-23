/**
 * Tests for the speaker rename dialog: the empty state (no stored roster),
 * prefilled name fields from the sidecar roster, rejecting a duplicate name,
 * applying renames through the recorded outputs (diffed against the stored
 * names, with roster and history persisted first), the LLM-skip notice,
 * undo, and creating and growing a participant profile.
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
	applySpeakerRenamesWithSidecar,
	hasUnscopableRecordedNote,
} from 'src/speakers/applySpeakerRenames';

jest.mock('src/speakers/applySpeakerRenames', () => ({
	applySpeakerRenamesWithSidecar: jest.fn(),
	hasUnscopableRecordedNote: jest.fn(),
}));

const applyMock = applySpeakerRenamesWithSidecar as jest.Mock;
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

/** A sidecar stub whose getTranscript resolves to the given section. */
function makeSidecar(
	section: TranscriptSection,
	corrupt = false,
): {
	getTranscript: jest.Mock;
	isSidecarCorrupt: jest.Mock;
	commitRename: jest.Mock;
	setSpeakers: jest.Mock;
	popHistory: jest.Mock;
} {
	return {
		getTranscript: jest.fn().mockResolvedValue(section),
		isSidecarCorrupt: jest.fn().mockReturnValue(corrupt),
		commitRename: jest.fn().mockResolvedValue(undefined),
		setSpeakers: jest.fn().mockResolvedValue(undefined),
		popHistory: jest.fn().mockResolvedValue(undefined),
	};
}

function makeModal(
	settings: AudioRecorderSettings,
	sidecar: SpeakerRenameSidecarAccess,
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

const cleanApplyResult = {
	updatedNotes: 1,
	updatedTranscriptFiles: 1,
	failed: 0,
	skippedLlmNotes: 0,
	missingOutputs: 0,
};

beforeEach(() => {
	applyMock.mockReset();
	unscopableMock.mockReset();
	applyMock.mockResolvedValue({ ...cleanApplyResult });
	unscopableMock.mockReturnValue(false);
});

describe('SpeakerRenameModal', () => {
	it('explains when no roster is stored for the recording', async () => {
		const { modal, internals } = makeModal(
			mergeSettings({}),
			makeSidecar(emptyTranscriptSection()),
		);
		modal.open();
		await internals.render();

		expect(modal.contentEl.textContent).toContain(
			'Transcribe it with speaker diarization first',
		);
		expect(internals.inputs.size).toBe(0);
	});

	it('shows the empty state when the sidecar read fails', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		sidecar.getTranscript.mockRejectedValue(new Error('io error'));
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(0);
		expect(modal.contentEl.textContent).toContain('No speakers are stored');
		warn.mockRestore();
	});

	it('distinguishes a corrupt sidecar from an empty one', async () => {
		// An unreadable sidecar must not tell the user to re-transcribe: the
		// stored names may be intact on disk.
		const { modal, internals } = makeModal(
			mergeSettings({}),
			makeSidecar(emptyTranscriptSection(), true),
		);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(0);
		expect(modal.contentEl.textContent).toContain('could not be read');
		expect(modal.contentEl.textContent).not.toContain(
			'Transcribe it with speaker diarization first',
		);
	});

	it('prefills one field per speaker with the stored names', async () => {
		const { modal, internals } = makeModal(
			mergeSettings({}),
			makeSidecar(rosterSection()),
		);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(2);
		expect(internals.inputs.get('Speaker 1')?.value).toBe('Alex');
		expect(internals.inputs.get('Speaker 2')?.value).toBe('');
		expect(internals.inputs.get('Speaker 2')?.placeholder).toBe(
			'Speaker 2',
		);
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
		second.value = ' Cleo ';
		await internals.apply();

		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[
				{ label: 'Speaker 1', name: 'Bob' },
				{ label: 'Speaker 2', name: 'Cleo' },
			],
			{ 'Speaker 1': 'Bob', 'Speaker 2': 'Cleo' },
		);
		// Self-healing rules: each speaker's replacement targets both the
		// stored name ("Alex", what a rewritten output shows) and the engine
		// label ("Speaker 1", what an output missed by an earlier rewrite
		// still shows).
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[
				{ from: 'Speaker 1', to: 'Bob' },
				{ from: 'Alex', to: 'Bob' },
				{ from: 'Speaker 2', to: 'Cleo' },
			],
			{ allowBroad: false },
		);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				'Renamed speakers in 1 note and 1 transcript file',
			),
		);
	});

	it('rewrites the outputs before committing the roster and history', async () => {
		// If the roster were stored first, a failing rewrite would leave the
		// sidecar asserting names the outputs never received.
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

		const applyOrder = applyMock.mock.invocationCallOrder[0] ?? 0;
		const commitOrder =
			sidecar.commitRename.mock.invocationCallOrder[0] ?? 0;
		expect(applyOrder).toBeGreaterThan(0);
		expect(applyOrder).toBeLessThan(commitOrder);
	});

	it('keeps the sidecar untouched when the output rewrite throws', async () => {
		applyMock.mockRejectedValue(new Error('vault write failed'));
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

		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Failed to rename speakers'),
		);
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

		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
			{},
		);
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Alex', to: 'Speaker 1' }],
			{ allowBroad: false },
		);
	});

	it('rejects assigning one name to two speakers', async () => {
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
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
		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Two speakers cannot share a name'),
		);
	});

	it("explains why a name equal to another speaker's label is rejected", async () => {
		// Swapping raw engine labels (or naming one speaker after another's
		// label) would make their lines textually indistinguishable forever,
		// so the block is deliberate - and the message says which collision.
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Speaker 2';
		await internals.apply();

		expect(applyMock).not.toHaveBeenCalled();
		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				"A name cannot equal another speaker's label (Speaker 2)",
			),
		);
	});

	it('does nothing when the entered names equal the stored ones', async () => {
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.apply();

		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(applyMock).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith('No speaker names to change.');
	});

	it('passes broad rewrite through when the user opts in', async () => {
		unscopableMock.mockReturnValue(true);
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(modal.contentEl.textContent).toContain(
			'Rename in notes without timecodes',
		);
		const input = internals.inputs.get('Speaker 2');
		if (!input) {
			throw new Error('missing input');
		}
		input.value = 'Bob';
		internals.allowBroad = true;
		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[
				// The unchanged "Alex" assignment still contributes its healing
				// rule for outputs that missed an earlier rewrite.
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Speaker 2', to: 'Bob' },
			],
			{ allowBroad: true },
		);
	});

	it('reports LLM-skipped notes in the outcome notice', async () => {
		applyMock.mockResolvedValue({
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

	it('reports skipped missing outputs in the outcome notice', async () => {
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			updatedTranscriptFiles: 1,
			missingOutputs: 2,
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
				'2 recorded output(s) no longer exist and were skipped',
			),
		);
	});

	it('does not report success when every recorded output is missing', async () => {
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			updatedTranscriptFiles: 0,
			missingOutputs: 1,
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
				'No speaker labels were rewritten. 1 recorded output(s) no longer exist',
			),
		);
	});

	it('creates a profile and adds applied names to it', async () => {
		const settings = mergeSettings({});
		const { modal, internals, saveSettings } = makeModal(
			settings,
			makeSidecar(rosterSection()),
		);
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

		const input = internals.inputs.get('Speaker 2');
		if (!input) {
			throw new Error('missing input');
		}
		input.value = 'Bob';
		await internals.apply();

		expect(settings.transcriptionSpeakerProfiles[0]?.participants).toEqual([
			'Alex',
			'Bob',
		]);
		expect(saveSettings).toHaveBeenCalled();
	});

	it('offers undo only when the history has entries', async () => {
		const withHistory = makeModal(
			mergeSettings({}),
			makeSidecar(
				rosterSection({
					history: [{ at: 't1', names: { 'Speaker 1': 'Alex' } }],
				}),
			),
		);
		withHistory.modal.open();
		await withHistory.internals.render();
		expect(withHistory.modal.contentEl.textContent).toContain(
			'Undo last rename',
		);

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

	it('undo reverts to the second-newest history state and pops the entry', async () => {
		const section = rosterSection({
			speakers: [{ label: 'Speaker 1', name: 'Bob' }],
			history: [
				{ at: 't1', names: { 'Speaker 1': 'Alex' } },
				{ at: 't2', names: { 'Speaker 1': 'Bob' } },
			],
		});
		const sidecar = makeSidecar(section);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.undo();

		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1', name: 'Alex' },
		]);
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Bob', to: 'Alex' },
			],
			{ allowBroad: false },
		);
		// True undo: the undone entry is removed, never re-appended, so the
		// next undo steps further back instead of ping-ponging.
		expect(sidecar.popHistory).toHaveBeenCalledWith('audio/rec.wav');
		expect(sidecar.commitRename).not.toHaveBeenCalled();
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
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			section,
			[{ from: 'Alex', to: 'Speaker 1' }],
			{ allowBroad: false },
		);
		expect(sidecar.popHistory).toHaveBeenCalledWith('audio/rec.wav');
		expect(sidecar.commitRename).not.toHaveBeenCalled();
	});

	it('undo pops the entry even when nothing needed rewriting', async () => {
		// The stored roster already matches the previous history state; the
		// entry is still consumed so the next undo walks further back.
		const section = rosterSection({
			speakers: [{ label: 'Speaker 1', name: 'Alex' }],
			history: [
				{ at: 't1', names: { 'Speaker 1': 'Alex' } },
				{ at: 't2', names: { 'Speaker 1': 'Alex' } },
			],
		});
		const sidecar = makeSidecar(section);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.undo();

		expect(applyMock).not.toHaveBeenCalled();
		expect(sidecar.setSpeakers).not.toHaveBeenCalled();
		expect(sidecar.popHistory).toHaveBeenCalledWith('audio/rec.wav');
	});
});
