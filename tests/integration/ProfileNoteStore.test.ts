/**
 * Tests for the store that keeps note-backed profile bodies in step with their
 * notes: the read once the vault is loaded, edits, a rename of the note and of
 * its folder, a note that goes missing or arrives late, a reload of the
 * settings, and the roster the rename dialog appends to a note.
 * @module tests/integration/ProfileNoteStore.test
 */

import { App } from 'obsidian';
import type { Plugin, TFile } from 'obsidian';
import {
	ProfileNoteStore,
	appendParticipantsToNote,
	lostProfileSourceNotice,
} from 'src/settings/ProfileNoteStore';
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
import { TFile as MockTFile, TFolder as MockTFolder } from '../mocks/obsidian';
import { asMockVault } from '../helpers/obsidianMock';
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

	it('keeps the text last read when the note goes missing, and names it for a run', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		vault().forget(NOTE);

		expect(await store.reconcile()).toBe(false);
		expect(glossary().body).toBe('- Kubernetes');
		expect(resolveDictionaryTermList(settings)).toEqual(['Kubernetes']);
		expect(lostProfileSourceNotice(app.vault, settings, ['advanced'])).toBe(
			'The note of profile "Standup" (Glossaries/Standup.md) is missing, so the text last read from it is used.',
		);
		// A run that applies no glossary has nothing to be told about one.
		expect(
			lostProfileSourceNotice(app.vault, settings, ['llm']),
		).toBeNull();
	});

	it('says nothing to a run while every note is in place', async () => {
		seedNote('- Kubernetes');
		store.register(plugin);
		await settle();

		expect(
			lostProfileSourceNotice(app.vault, settings, ['advanced']),
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
