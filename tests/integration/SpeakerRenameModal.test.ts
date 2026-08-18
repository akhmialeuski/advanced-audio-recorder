/**
 * Tests for the speaker rename dialog: the empty state (no stored roster),
 * prefilled name fields from the sidecar roster, the per-speaker preview
 * column, rejecting a duplicate name, applying renames through the recorded
 * outputs (diffed against the stored names, with roster and history persisted
 * first), a repeated apply that heals the outputs without recording anything,
 * the notice that names why a note went untouched, undo, and the participant
 * roster the recording carries alongside the settings profiles.
 * @jest-environment jsdom
 */

import type { App, ButtonComponent, TFile } from 'obsidian';
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

const audioFile = {
	name: 'rec.wav',
	path: 'audio/rec.wav',
} as unknown as TFile;

const app = {
	vault: { getResourcePath: () => 'app://vault/audio/rec.wav' },
} as unknown as App;

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

/** A controllable audio element installed as the global Audio factory. */
interface PreviewAudioHarness {
	element: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	load: jest.SpyInstance<void, []>;
	constructions(): number;
	/** Moves the playhead and emits timeupdate, as playback would. */
	advanceTo(seconds: number): void;
	restore(): void;
}

/**
 * Installs a deterministic audio element for the preview column, so pressing a
 * play button exercises the real player instead of jsdom's unimplemented media.
 */
function installPreviewAudio(): PreviewAudioHarness {
	const element = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	Object.defineProperties(element, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => 600 },
		readyState: { configurable: true, get: () => 1 },
	});
	const play = jest.spyOn(element, 'play').mockImplementation(() => {
		paused = false;
		return Promise.resolve();
	});
	const pause = jest.spyOn(element, 'pause').mockImplementation(() => {
		paused = true;
	});
	const load = jest
		.spyOn(element, 'load')
		.mockImplementation(() => undefined);
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => element);
	return {
		element,
		play,
		pause,
		load,
		constructions: () => factory.mock.calls.length,
		advanceTo: (seconds: number) => {
			currentTime = seconds;
			element.dispatchEvent(new Event('timeupdate'));
		},
		restore: () => {
			factory.mockRestore();
		},
	};
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

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Bob';
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

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Bob';
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

		const first = internals.inputs.get('Speaker 1');
		if (!first) {
			throw new Error('missing input');
		}
		first.value = 'Bob';
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
		const audio = installPreviewAudio();
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

		expect(audio.element.currentTime).toBe(12);
		expect(audio.play).toHaveBeenCalled();
		expect(first.buttonEl.getAttribute('data-icon')).toBe('square');
		expect(second.buttonEl.getAttribute('data-icon')).toBe('play');

		// Starting the other speaker moves the stop affordance with it.
		second.buttonEl.click();
		expect(audio.element.currentTime).toBe(40);
		expect(first.buttonEl.getAttribute('data-icon')).toBe('play');
		expect(second.buttonEl.getAttribute('data-icon')).toBe('square');

		// A second press stops, and reaching the end would too.
		second.buttonEl.click();
		expect(internals.preview?.playingId).toBeNull();
		expect(second.buttonEl.getAttribute('data-icon')).toBe('play');
		audio.restore();
	});

	it('resets the button when the excerpt ends on its own', async () => {
		const audio = installPreviewAudio();
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

		const button = internals.previewButtons.get('Speaker 1');
		button?.buttonEl.click();
		audio.advanceTo(20);

		expect(internals.preview?.playingId).toBeNull();
		expect(button?.buttonEl.getAttribute('data-icon')).toBe('play');
		audio.restore();
	});

	it('builds no audio element until a preview is pressed', async () => {
		const audio = installPreviewAudio();
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

		expect(internals.preview).toBeNull();
		expect(audio.constructions()).toBe(0);
		audio.restore();
	});

	it('stops and releases the preview when the dialog closes', async () => {
		const audio = installPreviewAudio();
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
		internals.previewButtons.get('Speaker 1')?.buttonEl.click();

		modal.close();

		expect(audio.pause).toHaveBeenCalled();
		expect(audio.load).toHaveBeenCalled();
		expect(internals.preview).toBeNull();
		audio.restore();
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
			transcriptionSpeakerProfiles: [
				{
					id: 'p1',
					name: 'Weekly sync',
					participants: ['Maria', 'Ivan'],
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
		const settings = mergeSettings({
			transcriptionSpeakerProfiles: [
				{ id: 'p1', name: 'Weekly sync', participants: ['Maria'] },
			],
		});
		const sidecar = makeSidecar(
			rosterSection({
				speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
				participants: ['Alex'],
				participantProfileId: 'p1',
			}),
		);
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
		expect(settings.transcriptionSpeakerProfiles[0]?.participants).toEqual([
			'Maria',
			'Ivan',
		]);
		expect(saveSettings).toHaveBeenCalled();
	});

	it('records "no profile" when the recording roster is the only source', async () => {
		const settings = mergeSettings({
			transcriptionSpeakerProfiles: [
				{ id: 'p1', name: 'Weekly sync', participants: ['Maria'] },
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
		expect(settings.transcriptionSpeakerProfiles[0]?.participants).toEqual([
			'Maria',
		]);
	});
});
