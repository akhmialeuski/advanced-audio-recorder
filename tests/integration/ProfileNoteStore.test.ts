/**
 * Tests for the store that keeps note-backed profile bodies in step with their
 * notes: the read once the vault is loaded, edits, a rename of the note and of
 * its folder, a note that goes missing or arrives late, a note picked again
 * after a detach, a reload of the settings, an unload with a write pending, the
 * read a run makes of its notes as it starts, and the roster the rename dialog
 * appends to a note.
 * @module tests/integration/ProfileNoteStore.test
 */

import { App } from 'obsidian';
import type { Plugin, TFile } from 'obsidian';
import {
	ProfileNoteStore,
	appendParticipantsToNote,
	readProfileNotes,
} from 'src/settings/ProfileNoteStore';
import { ProfileTextSource } from 'src/settings/ProfileTextSource';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	resolveDictionaryTermList,
	resolveLlmPrompt,
} from 'src/settings/profileResolution';
import {
	findProfile,
	setSelectedProfileId,
	type Profile,
} from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import {
	MarkdownView as MockMarkdownView,
	TFile as MockTFile,
	TFolder as MockTFolder,
} from '../mocks/obsidian';
import { asMockVault, asMockWorkspace } from '../helpers/obsidianMock';
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';

const NOTE = 'Glossaries/Standup.md';

/** Quiet period the store waits for before writing note edits to data.json. */
const PERSIST_DEBOUNCE_MS = 2000;

/**
 * Settings with one glossary read from the note and in use, as a transcription
 * with the advanced settings on would apply it.
 * @param body - The text the glossary was last read as
 */
function settingsWithNoteGlossary(body: string): AudioRecorderSettings {
	const settings = mergeSettings({
		profiles: [
			{
				id: 'g1',
				kind: 'dictionary',
				name: 'Standup',
				body,
				sourcePath: NOTE,
			},
		],
	});
	settings.transcriptionEnabled = true;
	settings.transcriptionAdvancedSettingsEnabled = true;
	setSelectedProfileId(settings, 'dictionary', 'g1');
	return settings;
}

describe('ProfileNoteStore', () => {
	let app: App;
	let settings: AudioRecorderSettings;
	let persist: jest.Mock;
	let plugin: Plugin;
	let store: ProfileNoteStore;

	beforeEach(() => {
		// The note edits are written through a debounce; fake timers let a
		// test say when the typing has paused.
		jest.useFakeTimers();
		app = new App();
		settings = settingsWithNoteGlossary('Stale');
		persist = jest.fn().mockResolvedValue(undefined);
		plugin = partial<Plugin>({
			register: jest.fn(),
			registerEvent: jest.fn((ref: unknown) => ref),
		});
		store = new ProfileNoteStore(app, () => settings, persist);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const vault = (): ReturnType<typeof asMockVault> => asMockVault(app.vault);

	/** The glossary as the live settings hold it now. */
	const glossary = (): Profile => {
		const profile = findProfile(settings.profiles, 'g1');
		if (!profile) {
			throw new Error('The glossary is gone from the settings.');
		}
		return profile;
	};

	/** Lets every read already started finish, without passing the debounce. */
	const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(0);

	/** Puts the note in the vault as the given text. */
	const seedNote = (content: string): MockTFile =>
		at(vault().seed([{ path: NOTE, content }]), 0);

	/** Saves new text into the note the way the editor does, and lets it be read. */
	const saveNote = async (
		file: MockTFile,
		content: string,
	): Promise<void> => {
		await vault().modify(file, content);
		vault().trigger('modify', file);
		await settle();
	};

	/** Clears the note on the profile's page, and the save that follows reconciles. */
	const detach = async (): Promise<void> => {
		delete glossary().sourcePath;
		await store.reconcile();
	};

	/** Picks the note on the profile's page again, and the save reconciles. */
	const pickAgain = async (): Promise<void> => {
		glossary().sourcePath = NOTE;
		await store.reconcile();
	};

	it('reads the note once the vault is loaded, leaving its frontmatter out', async () => {
		seedNote('---\ntags: [glossary]\n---\n# Terms\n- Kubernetes\n- gRPC\n');
		// Before the first read the stored copy answers, and synchronously.
		expect(resolveDictionaryTermList(settings)).toEqual(['Stale']);

		store.register(plugin);
		await settle();

		expect(glossary().body).toBe('# Terms\n- Kubernetes\n- gRPC\n');
		expect(resolveDictionaryTermList(settings)).toEqual([
			'Kubernetes',
			'gRPC',
		]);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(plugin.registerEvent).toHaveBeenCalledTimes(3);
	});

	it('follows edits of the note, and writes data.json once they settle', async () => {
		const file = seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		persist.mockClear();

		await vault().modify(file, '- Kubernetes\n- Helm');
		vault().trigger('modify', file);
		await vault().modify(file, '- Kubernetes\n- Helm\n- Argo');
		vault().trigger('modify', file);
		await settle();

		expect(glossary().body).toBe('- Kubernetes\n- Helm\n- Argo');
		expect(persist).not.toHaveBeenCalled();

		await jest.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);

		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('drops a write still pending when the plugin unloads', async () => {
		const edited = seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		await saveNote(edited, '- Helm');
		persist.mockClear();

		// Obsidian runs what a plugin registered once it unloads the plugin.
		for (const [cleanup] of jest.mocked(plugin.register).mock.calls) {
			cleanup();
		}
		await jest.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);

		expect(persist).toHaveBeenCalledTimes(0);
	});

	it('ignores a note no profile is read from', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		persist.mockClear();
		const other = at(
			vault().seed([{ path: 'Journal/Today.md', content: 'Notes' }]),
			0,
		);

		vault().trigger('modify', other);
		await jest.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);

		expect(glossary().body).toBe('- Kubernetes');
		expect(persist).not.toHaveBeenCalled();
	});

	it('reads nothing for an event about a folder', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		vault().cachedRead.mockClear();

		vault().trigger('modify', new MockTFolder('Glossaries'));
		await settle();

		expect(vault().cachedRead).not.toHaveBeenCalled();
	});

	it('keeps the body when the note cannot be read, and reads it next time', async () => {
		seedNote('- Kubernetes');
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		vault().cachedRead.mockRejectedValueOnce(new Error('EBUSY'));

		expect(await store.reconcile()).toBe(false);
		expect(glossary().body).toBe('Stale');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(NOTE),
			expect.any(Error),
		);

		expect(await store.reconcile()).toBe(true);
		expect(glossary().body).toBe('- Kubernetes');
		warn.mockRestore();
	});

	it('reads a note again at the next save after the read of an edit failed', async () => {
		const file = seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		vault().cachedRead.mockRejectedValueOnce(new Error('EBUSY'));

		await saveNote(file, '- Helm');

		expect(glossary().body).toBe('- Kubernetes');
		// The note was read before, and a reconcile skips a note it has read.
		expect(await store.reconcile()).toBe(true);
		expect(glossary().body).toBe('- Helm');
	});

	it('follows the note through a rename and a move of its folder', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();
		persist.mockClear();

		vault().trigger('rename', new MockTFile('Glossaries/Daily.md'), NOTE);

		expect(glossary().sourcePath).toBe('Glossaries/Daily.md');
		// Written at once: a stale path on disk finds no note at the next load.
		expect(persist).toHaveBeenCalledTimes(1);

		vault().trigger(
			'rename',
			new MockTFolder('Work/Glossaries'),
			'Glossaries',
		);

		expect(glossary().sourcePath).toBe('Work/Glossaries/Daily.md');

		// A folder whose name only begins the same way is another folder.
		vault().trigger('rename', new MockTFolder('Elsewhere'), 'Work/Gloss');

		expect(glossary().sourcePath).toBe('Work/Glossaries/Daily.md');
		expect(glossary().body).toBe('- Kubernetes');
	});

	it('reads the note again when it is picked back after changing while detached', async () => {
		const note = seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		await detach();
		// Saved while no profile names it, so no read follows the save.
		await saveNote(note, '- Helm');
		await pickAgain();

		expect(glossary().body).toBe('- Helm');
	});

	it('reads the note again when it is picked back after the body was typed', async () => {
		seedNote('- Kubernetes');
		await store.reconcile();

		await detach();
		glossary().body = 'Typed on the page';
		await pickAgain();

		expect(glossary().body).toBe('- Kubernetes');
	});

	it('keeps the text last read when the note goes missing, and names it for a run', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		vault().forget(NOTE);

		expect(await store.reconcile()).toBe(false);
		expect(glossary().body).toBe('- Kubernetes');
		expect(resolveDictionaryTermList(settings)).toEqual(['Kubernetes']);
		expect(
			new ProfileTextSource(app.vault).lostNotesNotice(settings, [
				'dictionary',
			]),
		).toBe(
			'The note of profile "Standup" (Glossaries/Standup.md) is missing, so the text last read from it is used.',
		);
		// A run that reads no glossary has nothing to be told about one.
		expect(
			new ProfileTextSource(app.vault).lostNotesNotice(settings, [
				'llmCleanup',
			]),
		).toBeNull();
	});

	it('says nothing to a run while every note is in place', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		expect(
			new ProfileTextSource(app.vault).lostNotesNotice(settings, [
				'dictionary',
			]),
		).toBeNull();
	});

	it('reads a note that arrives after a load that found none', async () => {
		store.register(plugin);
		await settle();
		expect(glossary().body).toBe('Stale');
		expect(persist).not.toHaveBeenCalled();

		// Delivered by sync, or restored from the trash.
		vault().trigger('create', seedNote('- Kubernetes'));
		await jest.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);

		expect(glossary().body).toBe('- Kubernetes');
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('reads every note again after a reload of the settings', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		// A reload builds new profile objects from a data.json whose bodies
		// were cached on another device.
		settings = settingsWithNoteGlossary('- Older');

		expect(await store.reconcile()).toBe(true);
		expect(glossary().body).toBe('- Kubernetes');
		// Read once, a note is not read again until something changes.
		expect(await store.reconcile()).toBe(false);
		expect(vault().cachedRead).toHaveBeenCalledTimes(2);
	});

	it('reads a prompt picked from a note verbatim, markup and all', async () => {
		const prompt = at(
			vault().seed([
				{
					path: 'Prompts/Cleanup.md',
					content:
						'---\nowner: me\n---\n- Keep the bullets.\n# And the heading',
				},
			]),
			0,
		);
		settings.profiles = [
			{ id: 'c1', kind: 'llmCleanup', name: 'Cleanup', body: '' },
		];
		setSelectedProfileId(settings, 'llmCleanup', 'c1');

		at(settings.profiles, 0).sourcePath = prompt.path;

		expect(await store.reconcile()).toBe(true);
		expect(resolveLlmPrompt(settings, 'cleanup')).toBe(
			'- Keep the bullets.\n# And the heading',
		);
	});

	it('drops a read that lands after the profile was pointed at another note', async () => {
		vault().seed([
			{ path: NOTE, content: '- Old' },
			{ path: 'Glossaries/New.md', content: '- New' },
		]);
		let release: (() => void) | undefined;
		vault().cachedRead.mockImplementationOnce(
			(): Promise<string> =>
				new Promise((resolve) => {
					release = (): void => {
						resolve('- Old');
					};
				}),
		);

		const pending = store.reconcile();
		glossary().sourcePath = 'Glossaries/New.md';
		release?.();

		expect(await pending).toBe(false);
		expect(glossary().body).toBe('Stale');
		expect(await store.reconcile()).toBe(true);
		expect(glossary().body).toBe('- New');
	});

	describe('readProfileNotes', () => {
		it('reads the note as a run starts, though no event told of its change', async () => {
			const file = seedNote('- Kubernetes');
			await store.reconcile();
			// Written by git, a sync client, or another editor, and not yet
			// reported by the vault.
			await vault().modify(file, '- Helm');

			const { settings: run, unread } = await readProfileNotes(
				app,
				settings,
			);

			expect(resolveDictionaryTermList(run)).toEqual(['Helm']);
			expect(unread.size).toBe(0);
		});

		it('reads a note open in an editor with the text not saved yet', async () => {
			const view = new MockMarkdownView();
			view.file = seedNote('- Kubernetes');
			view.data = '---\ntags: [ops]\n---\n- Kubernetes\n- Helm';
			asMockWorkspace(app.workspace).getLeavesOfType.mockReturnValue([
				{ view },
			]);

			const { settings: run } = await readProfileNotes(app, settings);

			expect(resolveDictionaryTermList(run)).toEqual([
				'Kubernetes',
				'Helm',
			]);
		});

		it('keeps the text a run started with while the note is saved again', async () => {
			const file = seedNote('- Kubernetes');
			store.register(plugin);
			await settle();

			const { settings: run } = await readProfileNotes(app, settings);
			await saveNote(file, '- Helm');

			expect(glossary().body).toBe('- Helm');
			expect(resolveDictionaryTermList(run)).toEqual(['Kubernetes']);
		});

		it('keeps the text last read from a note it cannot read, and names that note for the run', async () => {
			// The note is in the vault, so nothing but the failed read itself
			// can tell the run that its text is not the note's.
			seedNote('- Kubernetes');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			vault().read.mockRejectedValueOnce(new Error('EACCES'));

			const { settings: run, unread } = await readProfileNotes(
				app,
				settings,
			);

			expect(resolveDictionaryTermList(run)).toEqual(['Stale']);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(NOTE),
				expect.any(Error),
			);
			expect(
				new ProfileTextSource(app.vault, unread).lostNotesNotice(run, [
					'dictionary',
				]),
			).toBe(
				`The note of profile "Standup" (${NOTE}) could not be read, so the text last read from it is used.`,
			);
		});
	});
});

describe('appendParticipantsToNote', () => {
	/**
	 * Appends names to a roster note holding the given text.
	 * @param content - The note before the append
	 * @param names - Names applied in the rename dialog
	 * @returns Whether a name was new, and the note after the append
	 */
	async function append(
		content: string,
		names: readonly string[],
	): Promise<{ added: boolean; text: string }> {
		const app = new App();
		const file = at(
			asMockVault(app.vault).seed([{ path: 'People/Team.md', content }]),
			0,
		) as unknown as TFile;
		const added = await appendParticipantsToNote(app.vault, file, names);
		return { added, text: await app.vault.cachedRead(file) };
	}

	it('repeats the bullet the roster is written with', async () => {
		expect(await append('# Team\n* Alex\n', ['Bob'])).toEqual({
			added: true,
			text: '# Team\n* Alex\n* Bob\n',
		});
	});

	it('numbers the names on after an ordered roster', async () => {
		expect(await append('1. Alex\n2) Bob\n', ['Cleo', 'Dana'])).toEqual({
			added: true,
			text: '1. Alex\n2) Bob\n3) Cleo\n4) Dana\n',
		});
	});

	it('opens an empty checkbox after a roster of tasks', async () => {
		expect(await append('- [x] Alex\n', ['Bob'])).toEqual({
			added: true,
			text: '- [x] Alex\n- [ ] Bob\n',
		});
	});

	it('keeps a roster kept in a callout inside it, reading its linked names', async () => {
		expect(
			await append('> [!info] Team\n> - [[People/Alex Smith|Alex]]\n', [
				'Alex',
				'Bob',
			]),
		).toEqual({
			added: true,
			text: '> [!info] Team\n> - [[People/Alex Smith|Alex]]\n> - Bob\n',
		});
	});

	it('writes plain lines under a roster of plain lines', async () => {
		expect(await append('Alex', ['Bob', 'Cleo'])).toEqual({
			added: true,
			text: 'Alex\nBob\nCleo\n',
		});
	});

	it('adds only the names the roster lacks, whatever the frontmatter says', async () => {
		expect(
			await append('---\nlead: Bob\n---\n- Alex\n', [
				'Alex',
				'Bob',
				'Bob',
			]),
		).toEqual({
			added: true,
			text: '---\nlead: Bob\n---\n- Alex\n- Bob\n',
		});
	});

	it('leaves the note untouched when every name is already in it', async () => {
		expect(await append('- Alex\n', ['Alex'])).toEqual({
			added: false,
			text: '- Alex\n',
		});
	});

	it('starts an empty note with the names', async () => {
		expect(await append('', ['Alex'])).toEqual({
			added: true,
			text: 'Alex\n',
		});
	});
});
