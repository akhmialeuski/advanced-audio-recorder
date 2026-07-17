/**
 * Tests for the speaker rename dialog: rendering the roster, persisting
 * entered names, rewriting existing outputs, and growing the participant
 * registry.
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';
import type { SpeakerNameStore } from 'src/speakers/SpeakerNameStore';
import type { SpeakerNames } from 'src/speakers/speakerNameModel';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';

/** Internal surface the tests drive directly. */
interface ModalInternals {
	render(): Promise<void>;
	apply(): Promise<void>;
	inputs: Map<string, HTMLInputElement>;
}

const audioFile = {
	name: 'rec.wav',
	path: 'audio/rec.wav',
} as unknown as TFile;

/** In-memory stand-in for the speaker-name store. */
function makeStore(initial: SpeakerNames): SpeakerNameStore & {
	saved: SpeakerNames | null;
} {
	const store = {
		saved: null as SpeakerNames | null,
		get: jest.fn(async () => initial),
		set: jest.fn(async (_path: string, value: SpeakerNames) => {
			store.saved = value;
		}),
	};
	return store as unknown as SpeakerNameStore & {
		saved: SpeakerNames | null;
	};
}

function makeApp(
	files: Map<string, string>,
	resolvedLinks: Record<string, Record<string, number>> = {},
): App {
	return {
		vault: {
			getFileByPath: (path: string) =>
				files.has(path) ? ({ path } as unknown as TFile) : null,
			process: async (
				file: TFile,
				fn: (content: string) => string,
			): Promise<string> => {
				const next = fn(files.get(file.path) ?? '');
				files.set(file.path, next);
				return next;
			},
		},
		metadataCache: { resolvedLinks },
	} as unknown as App;
}

function makeModal(
	app: App,
	store: SpeakerNameStore,
	settings: AudioRecorderSettings,
): {
	modal: SpeakerRenameModal;
	internals: ModalInternals;
	saveSettings: jest.Mock;
} {
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const modal = new SpeakerRenameModal(app, audioFile, {
		store,
		getSettings: () => settings,
		saveSettings,
	});
	return {
		modal,
		internals: modal as unknown as ModalInternals,
		saveSettings,
	};
}

describe('SpeakerRenameModal', () => {
	it('renders one input per roster speaker, prefilled with stored names', async () => {
		const store = makeStore({
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		});
		const { modal, internals } = makeModal(
			makeApp(new Map()),
			store,
			mergeSettings({}),
		);
		modal.open();
		await internals.render();

		expect(internals.inputs.size).toBe(2);
		expect(internals.inputs.get('Speaker 1')?.value).toBe('Alex');
		expect(internals.inputs.get('Speaker 2')?.value).toBe('');
	});

	it('explains when the recording has no speaker roster yet', async () => {
		const store = makeStore({ speakers: [], names: {} });
		const { modal, internals } = makeModal(
			makeApp(new Map()),
			store,
			mergeSettings({}),
		);
		modal.open();
		await internals.render();

		expect(modal.contentEl.textContent).toContain(
			'Transcribe it with speaker diarization first.',
		);
		expect(internals.inputs.size).toBe(0);
	});

	it('persists entered names and rewrites existing outputs on apply', async () => {
		const files = new Map<string, string>([
			['audio/rec.txt', '[0:00] Speaker 1: hi'],
			['meeting.md', '[[rec#t=0|0:00]] **Speaker 1** hi'],
		]);
		const app = makeApp(files, { 'meeting.md': { 'audio/rec.wav': 1 } });
		const store = makeStore({
			speakers: ['Speaker 1', 'Speaker 2'],
			names: {},
		});
		const settings = mergeSettings({});
		const { modal, internals, saveSettings } = makeModal(
			app,
			store,
			settings,
		);
		modal.open();
		await internals.render();

		const input = internals.inputs.get('Speaker 1');
		if (!input) {
			throw new Error('missing input for Speaker 1');
		}
		input.value = ' Alex ';
		await internals.apply();

		expect(store.saved).toEqual({
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		});
		expect(files.get('audio/rec.txt')).toBe('[0:00] Alex: hi');
		expect(files.get('meeting.md')).toContain('**Alex** hi');
		// The applied name joins the participant registry and is persisted.
		expect(settings.transcriptionParticipants).toBe('Alex');
		expect(saveSettings).toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('updated 1 note and 1 transcript file'),
		);
	});

	it('reverts a cleared name to the original label in outputs', async () => {
		const files = new Map<string, string>([
			['audio/rec.txt', '[0:00] Alex: hi'],
		]);
		const store = makeStore({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
		const { modal, internals } = makeModal(
			makeApp(files),
			store,
			mergeSettings({}),
		);
		modal.open();
		await internals.render();

		const input = internals.inputs.get('Speaker 1');
		if (!input) {
			throw new Error('missing input for Speaker 1');
		}
		input.value = '';
		await internals.apply();

		expect(store.saved).toEqual({ speakers: ['Speaker 1'], names: {} });
		expect(files.get('audio/rec.txt')).toBe('[0:00] Speaker 1: hi');
	});

	it('does not rewrite anything when the names are unchanged', async () => {
		const files = new Map<string, string>([
			['audio/rec.txt', '[0:00] Alex: hi'],
		]);
		const app = makeApp(files);
		const processSpy = jest.spyOn(app.vault, 'process');
		const store = makeStore({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
		const { modal, internals } = makeModal(app, store, mergeSettings({}));
		modal.open();
		await internals.render();
		await internals.apply();

		expect(processSpy).not.toHaveBeenCalled();
		expect(store.saved).toEqual({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
	});
});
