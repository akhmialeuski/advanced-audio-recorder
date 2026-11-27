/**
 * Tests that the terms a note template collected reach the dictionary
 * profile: the dialog picking them, and the profile they are added to, typed
 * in the settings or kept in a note.
 * @module tests/integration/dictionaryTerms.test
 */

import { App } from 'obsidian';
import { addTermsToDictionary } from 'src/settings/dictionaryGrowth';
import type { Profile } from 'src/settings/profiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import {
	DictionaryTermsModal,
	dictionaryTermsAction,
} from 'src/ui/DictionaryTermsModal';
import { asMockVault } from '../helpers/obsidianMock';
import { flushMicrotasks } from '../helpers/async';
import { allEls } from '../helpers/dom';
import { silenceConsole } from '../helpers/doubles';
import { rowToggle, settingRow } from '../helpers/settingRows';
import { modalInstances, noticeMessages } from '../mocks/obsidian';

const GLOSSARY = 'Glossaries/Platform.md';

/** A typed dictionary profile. */
const TYPED: Profile = {
	id: 'd',
	kind: 'dictionary',
	name: 'Platform',
	body: 'Helm',
};

/**
 * The plugin's settings and vault, holding the given profiles and a glossary
 * note.
 * @param profiles - The stored profiles
 */
function createSut(profiles: Profile[] = [TYPED]) {
	const app = new App();
	asMockVault(app.vault).seed([
		{ path: GLOSSARY, content: '# Platform\n\n- Helm\n' },
	]);
	const settings: AudioRecorderSettings = mergeSettings({ profiles });
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const store = { app, settings, saveSettings };
	return { app, settings, saveSettings, store };
}

describe('addTermsToDictionary', () => {
	it('appends the new terms to a typed profile and saves the settings', async () => {
		const sut = createSut();

		await expect(
			addTermsToDictionary(sut.store, 'd', ['helm', 'Argo CD', 'SLO']),
		).resolves.toBe('Added 2 terms to dictionary profile "Platform".');
		expect(sut.settings.profiles[0]?.body).toBe('Helm\nArgo CD\nSLO');
		expect(sut.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('saves nothing when every term is already there', async () => {
		const sut = createSut();

		await expect(
			addTermsToDictionary(sut.store, 'd', ['HELM']),
		).resolves.toBe(
			'Dictionary profile "Platform" already holds every term picked.',
		);
		expect(sut.saveSettings).not.toHaveBeenCalled();
	});

	it('continues the list of the note a profile is read from', async () => {
		const sut = createSut([{ ...TYPED, sourcePath: GLOSSARY }]);

		await expect(
			addTermsToDictionary(sut.store, 'd', ['Argo CD']),
		).resolves.toBe('Added 1 term to dictionary profile "Platform".');
		await expect(
			sut.app.vault.read(sut.app.vault.getFileByPath(GLOSSARY)!),
		).resolves.toBe('# Platform\n\n- Helm\n- Argo CD\n');
		expect(sut.saveSettings).not.toHaveBeenCalled();
	});

	it('leaves a note that holds every term as it is', async () => {
		const sut = createSut([{ ...TYPED, sourcePath: GLOSSARY }]);

		await expect(
			addTermsToDictionary(sut.store, 'd', ['helm']),
		).resolves.toBe(
			'Dictionary profile "Platform" already holds every term picked.',
		);
		await expect(
			sut.app.vault.read(sut.app.vault.getFileByPath(GLOSSARY)!),
		).resolves.toBe('# Platform\n\n- Helm\n');
	});

	it('adds nothing when the note of the profile is gone', async () => {
		const sut = createSut([{ ...TYPED, sourcePath: 'Gone.md' }]);

		await expect(
			addTermsToDictionary(sut.store, 'd', ['Argo CD']),
		).resolves.toMatch(/Gone\.md.*, so no term was added\.$/);
	});

	it('adds nothing to a profile that was removed', async () => {
		const sut = createSut([]);

		await expect(addTermsToDictionary(sut.store, 'd', ['x'])).resolves.toBe(
			'That dictionary profile no longer exists, so no term was added.',
		);
	});

	it('says why when the settings cannot be saved', async () => {
		silenceConsole('warn');
		const sut = createSut();
		sut.saveSettings.mockRejectedValue(new Error('disk full'));

		await expect(
			addTermsToDictionary(sut.store, 'd', ['SLO']),
		).resolves.toBe(
			'The terms were not added to dictionary profile "Platform": disk full',
		);
	});
});

describe('the dialog picking the terms', () => {
	/** The Add button of the dialog. */
	const addButton = (modal: DictionaryTermsModal): HTMLButtonElement =>
		allEls<HTMLButtonElement>(modal.contentEl, 'button').find(
			(button) => button.textContent === 'Add',
		)!;

	it('opens from the notice button and adds only the terms picked', async () => {
		const sut = createSut();
		const action = dictionaryTermsAction(sut.store)({
			profile: TYPED,
			terms: ['Argo CD', 'meeting', 'SLO'],
		});
		expect(action.label).toBe('Add new terms to the dictionary (3)');

		action.run();
		const modal: unknown = modalInstances.at(-1);
		if (!(modal instanceof DictionaryTermsModal)) {
			throw new Error('The dialog did not open.');
		}
		expect(addButton(modal).disabled).toBe(true);
		rowToggle(settingRow(modal.contentEl, 'SLO')).click();
		rowToggle(settingRow(modal.contentEl, 'meeting')).click();
		rowToggle(settingRow(modal.contentEl, 'meeting')).click();
		rowToggle(settingRow(modal.contentEl, 'Argo CD')).click();
		expect(addButton(modal).disabled).toBe(false);
		addButton(modal).click();
		await flushMicrotasks();

		expect(sut.settings.profiles[0]?.body).toBe('Helm\nArgo CD\nSLO');
		expect(noticeMessages()).toContain(
			'Added 2 terms to dictionary profile "Platform".',
		);
	});

	it('adds nothing when cancelled', () => {
		const sut = createSut();
		const add = jest.fn();
		const modal = new DictionaryTermsModal(
			sut.app,
			{ profile: TYPED, terms: ['SLO'] },
			add,
		);
		modal.onOpen();

		allEls<HTMLButtonElement>(modal.contentEl, 'button')
			.find((button) => button.textContent === 'Cancel')
			?.click();

		expect(add).not.toHaveBeenCalled();
	});
});
