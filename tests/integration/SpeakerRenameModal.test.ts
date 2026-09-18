/**
 * Tests for the speaker rename dialog: the empty state (no stored roster),
 * prefilled name fields from the sidecar roster, the per-speaker preview
 * column, rejecting a duplicate name, applying renames through the recorded
 * outputs (diffed against the stored names, with roster and history persisted
 * first), a repeated apply that heals the outputs without recording anything,
 * the notice that names why a note went untouched, undo, and the participant
 * roster the recording carries alongside the settings profiles, read from its
 * note as the dialog opens, named under the picker when that read fails, and
 * reported when it cannot be written, while the rename goes ahead.
 * @jest-environment jsdom
 */

import type { ButtonComponent, TFile } from 'obsidian';
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
import { SpeakerPreviewPlayer } from 'src/player/SpeakerPreviewPlayer';
import { modalInstances, noticeMessages } from '../mocks/obsidian';
import { internalsOf, partial } from '../helpers/doubles';
import { applyAnsweringMerge, typeSpeakerNames } from '../helpers/speakerRows';
import { createMockApp } from '../helpers/createApp';
import { rowDescription, rowSelect, settingRow } from '../helpers/settingRows';
import { installControlledAudio } from '../helpers/mediaMocks';
import type { ControlledAudio } from '../helpers/mediaMocks';

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
	suggestionPool(): string[];
	inputs: Map<string, HTMLInputElement>;
	previewButtons: Map<string, ButtonComponent>;
	preview: SpeakerPreviewPlayer | null;
	selectedProfileId: string;
	allowBroad: boolean;
	newProfileInput: HTMLInputElement | null;
}

const audioFile = partial<TFile>({
	name: 'rec.wav',
	path: 'audio/rec.wav',
});

const app = createMockApp({
	vault: { getResourcePath: () => 'app://vault/audio/rec.wav' },
}).app;

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
		internals: internalsOf<ModalInternals>(modal),
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

/** A section whose two speakers are both still unnamed. */
function unnamedRosterSection(): TranscriptSection {
	return rosterSection({
		speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
	});
}

/**
 * The picked roster "Weekly sync" holding Maria, over a recording whose own
 * roster is Alex and whose two speakers are still unnamed.
 * @param sourcePath - The note the roster is read from, when it is kept in one
 */
function weeklySyncRoster(sourcePath?: string): {
	settings: AudioRecorderSettings;
	sidecar: ReturnType<typeof makeSidecar>;
} {
	return {
		settings: mergeSettings({
			profiles: [
				{
					id: 'p1',
					kind: 'participants',
					name: 'Weekly sync',
					body: 'Maria',
					...(sourcePath === undefined ? {} : { sourcePath }),
				},
			],
		}),
		sidecar: makeSidecar(
			rosterSection({
				speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
				participants: ['Alex'],
				participantProfileId: 'p1',
			}),
		),
	};
}

/**
 * Opens the dialog, names the second speaker, and applies.
 * @param dialog - The dialog and its internals
 * @param name - The name typed for the second speaker
 * @param meanwhile - What happens elsewhere while the dialog is open
 */
async function nameSecondSpeaker(
	dialog: { modal: SpeakerRenameModal; internals: ModalInternals },
	name: string,
	meanwhile: () => void = (): void => undefined,
): Promise<void> {
	dialog.modal.open();
	await dialog.internals.render();
	const second = dialog.internals.inputs.get('Speaker 2');
	if (!second) {
		throw new Error('missing input');
	}
	second.value = name;
	meanwhile();
	await dialog.internals.apply();
}

const cleanApplyResult = {
	updatedNotes: 1,
	updatedTranscriptFiles: 1,
	failed: 0,
	unscopableNotes: 0,
	alreadyCurrentNotes: 0,
	unmatchedNotes: 0,
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
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(0);
		expect(modal.contentEl.textContent).toContain('No speakers are stored');
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

		typeSpeakerNames(internals.inputs, {
			'Speaker 1': 'Bob',
			'Speaker 2': ' Cleo ',
		});
		await internals.apply();

		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[
				{ label: 'Speaker 1', name: 'Bob' },
				{ label: 'Speaker 2', name: 'Cleo' },
			],
			{ 'Speaker 1': 'Bob', 'Speaker 2': 'Cleo' },
			// The applied names join the recording's own roster, so the next
			// rename suggests them without any profile being picked.
			{ names: ['Bob', 'Cleo'], profileId: '' },
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

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
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

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
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

		typeSpeakerNames(internals.inputs, { 'Speaker 1': '' });
		await internals.apply();

		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
			{},
			{ names: [], profileId: '' },
		);
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Alex', to: 'Speaker 1' }],
			{ allowBroad: false },
		);
	});

	it('merges two speakers into one name once the merge is confirmed', async () => {
		// Diarization routinely splits one person across two labels; naming
		// both of them is the fix, and the only way to repair such a note.
		const sidecar = makeSidecar(unnamedRosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		typeSpeakerNames(internals.inputs, {
			'Speaker 1': 'Alex',
			'Speaker 2': 'Alex',
		});

		await applyAnsweringMerge(() => internals.apply(), 'Merge');

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Speaker 2', to: 'Alex' },
			],
			{ allowBroad: false },
		);
		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Alex' },
			],
			{ 'Speaker 1': 'Alex', 'Speaker 2': 'Alex' },
			{ names: ['Alex', 'Alex'], profileId: '' },
		);
	});

	it('names the speakers it is about to merge', async () => {
		const { modal, internals } = makeModal(
			mergeSettings({}),
			makeSidecar(unnamedRosterSection()),
		);
		modal.open();
		await internals.render();
		typeSpeakerNames(internals.inputs, {
			'Speaker 1': 'Alex',
			'Speaker 2': 'Alex',
		});

		const asked = await applyAnsweringMerge(
			() => internals.apply(),
			'Cancel',
		);

		expect(asked).toContain('Speaker 1, Speaker 2 become Alex.');
	});

	it('writes nothing when the merge is not confirmed', async () => {
		const sidecar = makeSidecar(unnamedRosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		typeSpeakerNames(internals.inputs, {
			'Speaker 1': 'Alex',
			'Speaker 2': 'Alex',
		});

		await applyAnsweringMerge(() => internals.apply(), 'Cancel');

		expect(applyMock).not.toHaveBeenCalled();
		expect(sidecar.commitRename).not.toHaveBeenCalled();
	});

	it('asks nothing when the stored roster already carries the merge', async () => {
		// A repeat only heals the outputs; asking again for a merge already
		// applied would nag on every press.
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [
					{ label: 'Speaker 1', name: 'Alex' },
					{ label: 'Speaker 2', name: 'Alex' },
				],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		const before = modalInstances.length;

		await internals.apply();

		expect(modalInstances).toHaveLength(before);
		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Speaker 2', to: 'Alex' },
			],
			{ allowBroad: false },
		);
	});

	it('leaves a merged name alone when the speakers are given separate names again', async () => {
		// Both speakers already render as "Alex", so nothing in the outputs
		// says which of them a line belonged to.
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [
					{ label: 'Speaker 1', name: 'Alex' },
					{ label: 'Speaker 2', name: 'Alex' },
				],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		typeSpeakerNames(internals.inputs, {
			'Speaker 1': 'Alex',
			'Speaker 2': 'Bob',
		});

		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Speaker 2', to: 'Bob' },
			],
			{ allowBroad: false },
		);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				'Left as it is: "Alex" - shown by more than one speaker',
			),
		);
	});

	it("explains why a name equal to another speaker's label is rejected", async () => {
		// Naming one speaker after another's engine label says nothing about
		// which of the two a written occurrence belonged to, so the block is
		// deliberate - and the message points at the merge that does work.
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Speaker 2' });
		await internals.apply();

		expect(applyMock).not.toHaveBeenCalled();
		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				"A name cannot equal another speaker's label (Speaker 2)",
			),
		);
	});

	it('repeats the rewrite without recording when the names are unchanged', async () => {
		// The roster and the outputs are different questions. With the names
		// already stored there is nothing to commit, but the healing rule that
		// reaches an output still showing the engine label survives - and it
		// is the only thing that can ever reach it.
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Speaker 1', to: 'Alex' }],
			{ allowBroad: false },
		);
		// Nothing changed, so no history entry is appended for undo to walk.
		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(Notice).not.toHaveBeenCalledWith('No speaker names to change.');
	});

	it('does nothing when there is neither a name to store nor one to rewrite', async () => {
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.apply();

		expect(sidecar.commitRename).not.toHaveBeenCalled();
		expect(applyMock).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith('No speaker names to change.');
	});

	it('lets the broad opt-in reach a note a previous apply left behind', async () => {
		// The exact sequence the unscopable notice tells the user to perform:
		// the names were stored by an earlier apply, and this one exists only
		// to carry the opt-in down to the note that was skipped.
		unscopableMock.mockReturnValue(true);
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedTranscriptFiles: 0,
		});
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		internals.allowBroad = true;
		await internals.apply();

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Speaker 1', to: 'Alex' }],
			{ allowBroad: true },
		);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Renamed speakers in 1 note'),
		);
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

	it('points an unscopable note at the opt-in that would rewrite it', async () => {
		// This note was never attempted, so claiming it holds no matching
		// label would state a false reason and bury the one available remedy.
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			unscopableNotes: 1,
		});
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
		await internals.apply();

		const notice = jest.mocked(Notice).mock.calls.at(-1)?.[0] as string;
		expect(notice).toContain(
			'1 note(s) carry no timecode link for this recording',
		);
		expect(notice).toContain('Rename in notes without timecodes');
		// The other reason must not appear: it is the one that was disproved.
		expect(notice).not.toContain('no longer carry the speaker labels');
	});

	it('reports a note that was attempted and matched nothing', async () => {
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			unmatchedNotes: 1,
		});
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
		await internals.apply();

		const notice = jest.mocked(Notice).mock.calls.at(-1)?.[0] as string;
		expect(notice).toContain(
			'1 note(s) no longer carry the speaker labels they were written ' +
				'with',
		);
		expect(notice).not.toContain('Rename in notes without timecodes');
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

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
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

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
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

		const rosters = settings.profiles.filter(
			(profile) => profile.kind === 'participants',
		);
		expect(rosters).toHaveLength(1);
		expect(rosters[0]?.name).toBe('Weekly sync');
		expect(internals.selectedProfileId).toBe(rosters[0]?.id);

		const input = internals.inputs.get('Speaker 2');
		if (!input) {
			throw new Error('missing input');
		}
		input.value = 'Bob';
		await internals.apply();

		expect(
			settings.profiles.find((profile) => profile.name === 'Weekly sync')
				?.body,
		).toBe('Alex\nBob');
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

	it('undo still heals the outputs when the roster needs no change', async () => {
		// The stored roster already matches the previous history state, so
		// there is nothing to revert - but an output that missed the rewrite
		// still shows the engine label, and the healing rule reaches it. The
		// entry is consumed either way, so the next undo walks further back.
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

		expect(applyMock).toHaveBeenCalledWith(
			app,
			audioFile,
			expect.anything(),
			[{ from: 'Speaker 1', to: 'Alex' }],
			{ allowBroad: false },
		);
		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.wav', [
			{ label: 'Speaker 1', name: 'Alex' },
		]);
		expect(sidecar.popHistory).toHaveBeenCalledWith('audio/rec.wav');
	});

	it('undo reports an unscopable note without pointing at Apply', async () => {
		// The remedy is apply-shaped: telling someone who just pressed Undo to
		// apply again would walk the names forward, not back.
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			unscopableNotes: 1,
		});
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [{ label: 'Speaker 1', name: 'Alex' }],
				history: [{ at: 't1', names: { 'Speaker 1': 'Alex' } }],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();
		await internals.undo();

		const notice = jest.mocked(Notice).mock.calls.at(-1)?.[0] as string;
		expect(notice).toContain(
			'1 note(s) carry no timecode link for this recording and were ' +
				'left as they are.',
		);
		expect(notice).not.toContain('apply again');
	});

	it('reports a note that already uses these names without alarm', async () => {
		applyMock.mockResolvedValue({
			...cleanApplyResult,
			updatedNotes: 0,
			updatedTranscriptFiles: 1,
			alreadyCurrentNotes: 1,
		});
		const sidecar = makeSidecar(rosterSection());
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Bob' });
		await internals.apply();

		const notice = jest.mocked(Notice).mock.calls.at(-1)?.[0] as string;
		expect(notice).toContain('1 note(s) already use these names.');
		// Neither accusation may appear: the note was read back, not guessed at.
		expect(notice).not.toContain('no longer carry the speaker labels');
		expect(notice).not.toContain('carry no timecode link');
	});

	it('offers a preview button per speaker, disabled without stored offsets', async () => {
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [
					{
						label: 'Speaker 1',
						name: 'Alex',
						firstStart: 12,
						firstEnd: 20,
					},
					// A roster written before the offsets existed.
					{ label: 'Speaker 2' },
				],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		// Only the speaker with a stored offset gets a live button; the other
		// one is rendered disabled and never registers a toggle.
		expect([...internals.previewButtons.keys()]).toEqual(['Speaker 1']);
		const buttons = modal.contentEl.querySelectorAll(
			'button.aar-speaker-preview',
		);
		expect(buttons).toHaveLength(2);
		expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
		expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
		expect(modal.contentEl.textContent).toContain('First speaks at 0:12');
	});

	it('plays the speakers first turn and flips the button to stop', async () => {
		const audio = installControlledAudio({ duration: 600 });
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [
					{ label: 'Speaker 1', firstStart: 12, firstEnd: 20 },
					{ label: 'Speaker 2', firstStart: 40, firstEnd: 44 },
				],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		const first = internals.previewButtons.get('Speaker 1');
		const second = internals.previewButtons.get('Speaker 2');
		if (!first || !second) {
			throw new Error('missing preview buttons');
		}
		first.buttonEl.click();

		expect(audio.audio.currentTime).toBe(12);
		expect(audio.play).toHaveBeenCalled();
		expect(first.buttonEl.getAttribute('data-icon')).toBe('square');
		expect(second.buttonEl.getAttribute('data-icon')).toBe('play');

		// Starting the other speaker moves the stop affordance with it.
		second.buttonEl.click();
		expect(audio.audio.currentTime).toBe(40);
		expect(first.buttonEl.getAttribute('data-icon')).toBe('play');
		expect(second.buttonEl.getAttribute('data-icon')).toBe('square');

		// A second press stops, and reaching the end would too.
		second.buttonEl.click();
		expect(internals.preview?.playingId).toBeNull();
		expect(second.buttonEl.getAttribute('data-icon')).toBe('play');
	});

	/**
	 * A rendered dialog over one speaker whose first turn runs 12s to 20s -
	 * long enough to be excerpted without either clamp applying, which is what
	 * every preview test here wants to start from.
	 * @returns The audio element, the dialog, and its internals
	 */
	async function openWithOnePreviewableSpeaker(): Promise<{
		audio: ControlledAudio;
		modal: SpeakerRenameModal;
		internals: ModalInternals;
	}> {
		const audio = installControlledAudio({ duration: 600 });
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [
					{ label: 'Speaker 1', firstStart: 12, firstEnd: 20 },
				],
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		return { audio, modal, internals };
	}

	it('resets the button when the excerpt ends on its own', async () => {
		const { audio, internals } = await openWithOnePreviewableSpeaker();

		const button = internals.previewButtons.get('Speaker 1');
		button?.buttonEl.click();
		audio.advanceTo(20);

		expect(internals.preview?.playingId).toBeNull();
		expect(button?.buttonEl.getAttribute('data-icon')).toBe('play');
	});

	it('builds no audio element until a preview is pressed', async () => {
		const { audio, internals } = await openWithOnePreviewableSpeaker();

		expect(internals.preview).toBeNull();
		expect(audio.constructions()).toBe(0);
	});

	it('stops and releases the preview when the dialog closes', async () => {
		const { audio, modal, internals } =
			await openWithOnePreviewableSpeaker();
		internals.previewButtons.get('Speaker 1')?.buttonEl.click();

		modal.close();

		expect(audio.pause).toHaveBeenCalled();
		expect(audio.load).toHaveBeenCalled();
		expect(internals.preview).toBeNull();
	});

	it('suggests the names the recording carries, with no profile picked', async () => {
		const sidecar = makeSidecar(
			rosterSection({ participants: ['Alex', 'Maria'] }),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(internals.selectedProfileId).toBe('');
		expect(internals.suggestionPool()).toEqual(['Alex', 'Maria']);
		expect(modal.contentEl.textContent).toContain(
			'This recording suggests 2 stored names',
		);
	});

	it('re-selects the profile the transcription recorded and widens the pool', async () => {
		const settings = mergeSettings({
			profiles: [
				{
					id: 'p1',
					kind: 'participants',
					name: 'Weekly sync',
					body: 'Maria\nIvan',
				},
			],
		});
		const sidecar = makeSidecar(
			rosterSection({
				participants: ['Alex', 'Maria'],
				participantProfileId: 'p1',
			}),
		);
		const { modal, internals } = makeModal(settings, sidecar);
		modal.open();
		await internals.render();

		expect(internals.selectedProfileId).toBe('p1');
		// The recording's own names come first; the profile only widens.
		expect(internals.suggestionPool()).toEqual(['Alex', 'Maria', 'Ivan']);
	});

	it('falls back to the recording when the recorded profile is gone', async () => {
		const sidecar = makeSidecar(
			rosterSection({
				participants: ['Alex'],
				participantProfileId: 'deleted',
			}),
		);
		const { modal, internals } = makeModal(mergeSettings({}), sidecar);
		modal.open();
		await internals.render();

		expect(internals.selectedProfileId).toBe('');
		expect(internals.suggestionPool()).toEqual(['Alex']);
	});

	it('saves a name that is in neither the recording nor the profile to both', async () => {
		const { settings, sidecar } = weeklySyncRoster();
		const { modal, internals, saveSettings } = makeModal(settings, sidecar);
		modal.open();
		await internals.render();

		const second = internals.inputs.get('Speaker 2');
		if (!second) {
			throw new Error('missing input');
		}
		second.value = 'Ivan';
		await internals.apply();

		// The recording's own roster grows in the same atomic commit...
		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			[{ label: 'Speaker 1' }, { label: 'Speaker 2', name: 'Ivan' }],
			{ 'Speaker 2': 'Ivan' },
			{ names: ['Ivan'], profileId: 'p1' },
		);
		// ...and the picked profile learns the name too.
		expect(settings.profiles[0]?.body).toBe('Maria\nIvan');
		expect(saveSettings).toHaveBeenCalled();
	});

	it('renames the speakers when the profile with the new name cannot be saved', async () => {
		const { settings, sidecar } = weeklySyncRoster();
		const dialog = makeModal(settings, sidecar);
		// A save may fail with a bare message as well as with an Error.
		dialog.saveSettings.mockRejectedValueOnce('disk full');
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);

		await nameSecondSpeaker(dialog, 'Ivan');

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Weekly sync'),
			'disk full',
		);
		expect(sidecar.commitRename).toHaveBeenCalledTimes(1);
		expect(noticeMessages()).toContain(
			'The new names were not added to profile "Weekly sync": disk full',
		);
	});

	it('renames the speakers when the picked profile is deleted while the dialog is open', async () => {
		const { settings, sidecar } = weeklySyncRoster();
		const dialog = makeModal(settings, sidecar);

		await nameSecondSpeaker(dialog, 'Ivan', () => {
			settings.profiles = [];
		});

		expect(sidecar.commitRename).toHaveBeenCalledTimes(1);
		expect(dialog.saveSettings).not.toHaveBeenCalled();
	});

	describe('a roster kept in a note', () => {
		const NOTE_PATH = 'People/Weekly sync.md';

		/**
		 * A dialog over a vault that holds the roster note as the given text, or
		 * no note at all for null.
		 */
		function makeNoteModal(content: string | null): {
			internals: ModalInternals;
			modal: SpeakerRenameModal;
			process: jest.Mock;
			read: jest.Mock;
			settings: AudioRecorderSettings;
			sidecar: ReturnType<typeof makeSidecar>;
			noteText: () => string;
		} {
			let text = content ?? '';
			const note = partial<TFile>({
				path: NOTE_PATH,
				name: 'Weekly sync.md',
			});
			const process = jest.fn(
				(
					_file: TFile,
					fn: (data: string) => string,
				): Promise<string> => {
					text = fn(text);
					return Promise.resolve(text);
				},
			);
			const read = jest.fn(() => Promise.resolve(text));
			const noteApp = createMockApp({
				vault: {
					getResourcePath: () => 'app://vault/audio/rec.wav',
					getFileByPath: (path: string) =>
						content !== null && path === NOTE_PATH ? note : null,
					read,
					process,
				},
			}).app;
			const { settings, sidecar } = weeklySyncRoster(NOTE_PATH);
			const modal = new SpeakerRenameModal(noteApp, audioFile, {
				getSettings: () => settings,
				saveSettings: jest.fn().mockResolvedValue(undefined),
				sidecar,
			});
			return {
				internals: internalsOf<ModalInternals>(modal),
				modal,
				process,
				read,
				settings,
				sidecar,
				noteText: () => text,
			};
		}

		it('appends a new name to the note, in the list style it is written in', async () => {
			const dialog = makeNoteModal(
				'---\ntags: [team]\n---\n# Weekly sync\n- Maria\n',
			);

			await nameSecondSpeaker(dialog, 'Ivan');

			// The note is the user's document: appended to, never rewritten.
			expect(dialog.noteText()).toBe(
				'---\ntags: [team]\n---\n# Weekly sync\n- Maria\n- Ivan\n',
			);
			// The body follows through the modify the write raises. Written
			// here as well, it would only be overwritten by that read.
			expect(dialog.settings.profiles[0]?.body).toBe('Maria');
			expect(dialog.sidecar.commitRename).toHaveBeenCalledTimes(1);
		});

		it('suggests the names the roster note holds as the dialog opens', async () => {
			// The body is the roster last read, and Ivan joined the note since.
			const dialog = makeNoteModal('# Weekly sync\n- Maria\n- Ivan\n');
			dialog.modal.open();
			await dialog.internals.render();

			expect(dialog.internals.suggestionPool()).toEqual([
				'Alex',
				'Maria',
				'Ivan',
			]);
		});

		it('renames the speakers when the roster note cannot be written, and says so', async () => {
			const dialog = makeNoteModal('- Maria\n');
			dialog.process.mockRejectedValueOnce(new Error('EBUSY'));
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);

			await nameSecondSpeaker(dialog, 'Ivan');

			expect(dialog.sidecar.commitRename).toHaveBeenCalledTimes(1);
			expect(noticeMessages()).toContain(
				'The new names were not added to profile "Weekly sync": EBUSY',
			);
		});

		it('adds nothing to the note for a name it already holds', async () => {
			const dialog = makeNoteModal('- Maria\n');

			await nameSecondSpeaker(dialog, 'Maria');

			expect(dialog.noteText()).toBe('- Maria\n');
		});

		it('names under the picker the text of the picked roster, as the pick moves', async () => {
			const dialog = makeNoteModal('- Maria\n');
			dialog.modal.open();
			await dialog.internals.render();
			const picker = (): HTMLElement =>
				settingRow(dialog.modal.contentEl, 'Participant profile');

			expect(rowDescription(picker())).toContain(
				`Uses the text of ${NOTE_PATH}.`,
			);

			// The recording's own roster is no profile, so no text is named.
			rowSelect(picker()).value = '';
			rowSelect(picker()).dispatchEvent(new Event('change'));

			expect(rowDescription(picker())).not.toContain('Uses the text');

			// A profile created here is typed in, and is described in place
			// without rebuilding the dialog.
			if (dialog.internals.newProfileInput) {
				dialog.internals.newProfileInput.value = 'Standup';
			}
			await dialog.internals.createProfile();

			expect(rowDescription(picker())).toContain(
				'Uses the text typed in the settings.',
			);
		});

		/**
		 * Opens the dialog and reads the line under its profile picker.
		 * @param dialog - The dialog to open
		 */
		const pickerLineOnOpen = async (
			dialog: ReturnType<typeof makeNoteModal>,
		): Promise<string> => {
			dialog.modal.open();
			await dialog.internals.render();
			return rowDescription(
				settingRow(dialog.modal.contentEl, 'Participant profile'),
			);
		};

		it('says under the picker that the roster note is gone', async () => {
			expect(await pickerLineOnOpen(makeNoteModal(null))).toContain(
				`Uses the text last read from ${NOTE_PATH}, which is missing.`,
			);
		});

		it('says under the picker that the roster note could not be read, and suggests the roster last read', async () => {
			// Ivan joined the note, and its read fails however often it is tried.
			const dialog = makeNoteModal('- Maria\n- Ivan\n');
			dialog.read.mockRejectedValue(new Error('EBUSY'));
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);

			expect(await pickerLineOnOpen(dialog)).toContain(
				`Uses the text last read from ${NOTE_PATH}, which could not be read.`,
			);
			expect(dialog.internals.suggestionPool()).toEqual([
				'Alex',
				'Maria',
			]);
		});

		it('tells the user when the note is gone, and leaves the profile alone', async () => {
			const dialog = makeNoteModal(null);

			await nameSecondSpeaker(dialog, 'Ivan');

			expect(dialog.process).not.toHaveBeenCalled();
			expect(dialog.settings.profiles[0]?.body).toBe('Maria');
			expect(noticeMessages()).toContain(
				'The note of profile "Weekly sync" (People/Weekly sync.md) is missing, so the new names were not added to it.',
			);
		});
	});

	it('records "no profile" when the recording roster is the only source', async () => {
		const settings = mergeSettings({
			profiles: [
				{
					id: 'p1',
					kind: 'participants',
					name: 'Weekly sync',
					body: 'Maria',
				},
			],
		});
		const sidecar = makeSidecar(rosterSection({ participants: ['Alex'] }));
		const { modal, internals } = makeModal(settings, sidecar);
		modal.open();
		await internals.render();

		const second = internals.inputs.get('Speaker 2');
		if (!second) {
			throw new Error('missing input');
		}
		second.value = 'Ivan';
		await internals.apply();

		expect(sidecar.commitRename).toHaveBeenCalledWith(
			'audio/rec.wav',
			expect.anything(),
			expect.anything(),
			{ names: ['Alex', 'Ivan'], profileId: '' },
		);
		// No profile was picked, so none of them learned the name.
		expect(settings.profiles[0]?.body).toBe('Maria');
	});

	it.each([
		{ name: 'apply', act: (i: ModalInternals) => i.apply() },
		{ name: 'undo', act: (i: ModalInternals) => i.undo() },
	])(
		'does nothing on $name before the roster has loaded',
		async ({ act }) => {
			// The dialog is open and its buttons exist while the sidecar read is
			// still in flight; acting on a roster that is not there yet would
			// commit an empty rename.
			const { internals } = makeModal(
				mergeSettings({}),
				makeSidecar(rosterSection()),
			);

			await expect(act(internals)).resolves.toBeUndefined();
			expect(applyMock).not.toHaveBeenCalled();
		},
	);

	/**
	 * Types a name into the dialog's inline profile creator and submits it.
	 * @param settings - The settings the dialog reads and writes
	 * @param name - The name as typed, submitted untrimmed
	 * @returns The save spy, so a test can say whether anything was persisted
	 */
	const createProfileNamed = async (
		settings: AudioRecorderSettings,
		name: string,
	): Promise<jest.Mock> => {
		const { internals, saveSettings } = makeModal(
			settings,
			makeSidecar(rosterSection()),
		);
		await internals.render();
		const field = internals.newProfileInput;
		if (field) {
			field.value = name;
		}
		await internals.createProfile();
		return saveSettings;
	};

	/** Settings holding one participant profile, the name to collide with. */
	const withRoster = (): AudioRecorderSettings =>
		mergeSettings({
			profiles: [
				{
					id: 'p1',
					kind: 'participants',
					name: 'Weekly sync',
					body: 'Maria',
				},
			],
		});

	it('creates no profile from an empty name', async () => {
		const settings = mergeSettings({});
		jest.mocked(Notice).mockClear();

		const saveSettings = await createProfileNamed(settings, '   ');

		expect(saveSettings).not.toHaveBeenCalled();
		// Nothing typed yet is not a mistake to report back.
		expect(Notice).not.toHaveBeenCalled();
	});

	it('refuses a roster name another profile already holds', async () => {
		// A profile is a settings page addressed by its name, so a duplicate
		// created here would be a page the settings cannot tell from another.
		// The dialog applies the same rule the settings catalogue does, on the
		// trimmed name, so a stray space cannot smuggle one past it.
		const settings = withRoster();

		const saveSettings = await createProfileNamed(
			settings,
			'  Weekly sync ',
		);

		expect(settings.profiles).toHaveLength(1);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			'Another profile already uses this name.',
		);
	});

	it('creates a roster under a name no other profile holds', async () => {
		const settings = withRoster();

		const saveSettings = await createProfileNamed(settings, 'Standup');

		expect(settings.profiles.map((profile) => profile.name)).toEqual([
			'Weekly sync',
			'Standup',
		]);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it('writes no settings when the applied name is already in the roster', async () => {
		// The roster the profile holds is what a save would persist, and a name
		// it already carries leaves it exactly as it was. Saving anyway would
		// rewrite data.json on every rename that changes nothing there.
		const settings: AudioRecorderSettings = mergeSettings({
			profiles: [
				{
					id: 'p1',
					kind: 'participants',
					name: 'Standup',
					body: 'Maria',
				},
			],
		});
		const { internals, saveSettings } = makeModal(
			settings,
			makeSidecar(
				rosterSection({
					speakers: [{ label: 'Speaker 1' }],
				}),
			),
		);
		await internals.render();
		internals.selectedProfileId = 'p1';
		typeSpeakerNames(internals.inputs, { 'Speaker 1': 'Maria' });

		await internals.apply();

		expect(settings.profiles[0]?.body).toBe('Maria');
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it('adds nothing to a profile when every field was left blank', async () => {
		// Applying with no names is already a no-op; the profile must not
		// gain empty participants from it either.
		const settings: AudioRecorderSettings = mergeSettings({
			profiles: [
				{ id: 'p1', kind: 'participants', name: 'Standup', body: '' },
			],
		});
		const { internals, saveSettings } = makeModal(
			settings,
			makeSidecar(
				rosterSection({
					speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
				}),
			),
		);
		await internals.render();
		internals.selectedProfileId = 'p1';

		await internals.apply();

		expect(saveSettings).not.toHaveBeenCalled();
	});

	it('says what went wrong when the undo itself fails', async () => {
		const sidecar = makeSidecar(
			rosterSection({
				history: [
					{
						at: '2026-01-01T00:00:00Z',
						names: { 'Speaker 1': 'Alex' },
					},
				],
			}),
		);
		sidecar.popHistory.mockRejectedValue(new Error('sidecar is read-only'));
		const { internals } = makeModal(mergeSettings({}), sidecar);
		await internals.render();

		await internals.undo();

		expect(
			noticeMessages().some((message) =>
				message.includes('sidecar is read-only'),
			),
		).toBe(true);
	});
});
