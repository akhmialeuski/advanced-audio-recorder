/**
 * Tests the shared profile-manager section that renders both the dictionary
 * glossaries and the chapter guidance prompts. What matters is that one
 * renderer really drives two different lists: adding, removing, selecting, and
 * editing must land in the settings fields that kind of profile owns, and the
 * empty and stale-selection cases must stay recoverable rather than leaving the
 * editor pointed at a profile that no longer exists.
 * @module tests/unit/profileManagerSection.test
 */

import {
	renderChapterPromptProfiles,
	renderDictionaryProfiles,
} from 'src/settings/sections/profileManagerSection';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
	clickSettingButton,
	settingRow,
} from '../helpers/captureSettings';
import { at } from '../helpers/assertions';

jest.mock('obsidian', () => ({
	Platform: { isMobile: false, isMobileApp: false },
	Setting: jest.requireActual<typeof import('../helpers/captureSettings')>(
		'../helpers/captureSettings',
	).CapturingSetting,
}));

/** A rendered section plus the settings and hooks it was rendered against. */
interface Rendered {
	settings: AudioRecorderSettings;
	ctx: SettingsSectionContext;
}

/** Renders a profile section over the given settings. */
function render(
	kind: 'dictionary' | 'chapter',
	settings: AudioRecorderSettings,
): Rendered {
	capturedSettings.length = 0;
	const ctx: SettingsSectionContext = {
		containerEl: document.createElement('div'),
		settings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
	if (kind === 'dictionary') {
		renderDictionaryProfiles(ctx);
	} else {
		renderChapterPromptProfiles(ctx);
	}
	return { settings, ctx };
}

describe('profile manager section', () => {
	it('offers only the add button when no profile exists yet', () => {
		render(
			'dictionary',
			mergeSettings({ transcriptionDictionaryProfiles: [] }),
		);

		const selector = settingRow('Profile');
		expect(selector.dropdownOptions).toBeNull();
		expect(selector.buttons.map((b) => b.label)).toEqual(['plus']);
		// No profile means no editor: rendering name/body fields bound to
		// nothing is what an unguarded renderer would do.
		expect(capturedSettings.map((r) => r.name)).not.toContain(
			'Profile name',
		);
	});

	it('creates the first profile from the add button and saves it', async () => {
		const { settings, ctx } = render(
			'dictionary',
			mergeSettings({ transcriptionDictionaryProfiles: [] }),
		);

		await clickSettingButton('Profile', 'plus');

		const profiles = settings.transcriptionDictionaryProfiles;
		expect(profiles).toHaveLength(1);
		expect(at(profiles, 0).name).toBe('New profile');
		// The new profile is selected so its fields open for editing straight
		// away, and the section is redrawn to show them.
		expect(settings.transcriptionDictionaryProfileId).toBe(
			at(profiles, 0).id,
		);
		expect(ctx.save).toHaveBeenCalled();
		expect(ctx.rerender).toHaveBeenCalled();
	});

	it('edits the selected profile name and terms in place', () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: 'aorta' },
			],
			transcriptionDictionaryProfileId: 'a',
		});
		const { ctx } = render('dictionary', settings);

		changeSetting('Profile name', 'text', 'Cardiology');
		changeSetting('Terms', 'text', 'aorta\nstent');

		expect(at(settings.transcriptionDictionaryProfiles, 0)).toMatchObject({
			name: 'Cardiology',
			terms: 'aorta\nstent',
		});
		// Typing saves debounced so the caret is not lost mid-word; a plain
		// save here would re-render on every keystroke.
		expect(ctx.saveDebounced).toHaveBeenCalled();
		expect(ctx.rerender).not.toHaveBeenCalled();
	});

	it('makes a picked profile the run default and redraws the editor', async () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: '' },
				{ id: 'b', name: 'Legal', terms: '' },
			],
			transcriptionDictionaryProfileId: 'a',
		});
		const { ctx } = render('dictionary', settings);

		expect(settingRow('Profile').dropdownValue).toBe('a');
		await changeSetting('Profile', 'dropdown', 'b');

		expect(settings.transcriptionDictionaryProfileId).toBe('b');
		expect(ctx.save).toHaveBeenCalled();
		expect(ctx.rerender).toHaveBeenCalled();
	});

	it('removes the selected profile and falls back to the first remaining one', async () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: '' },
				{ id: 'b', name: 'Legal', terms: '' },
			],
			transcriptionDictionaryProfileId: 'b',
		});
		render('dictionary', settings);

		await clickSettingButton('Profile', 'trash');

		expect(
			settings.transcriptionDictionaryProfiles.map((p) => p.id),
		).toEqual(['a']);
		// A selection left pointing at the removed profile would render an
		// empty editor with no way back to the remaining one.
		expect(settings.transcriptionDictionaryProfileId).toBe('a');
	});

	it('clears the selection when the last profile is removed', async () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: '' },
			],
			transcriptionDictionaryProfileId: 'a',
		});
		render('dictionary', settings);

		await clickSettingButton('Profile', 'trash');

		expect(settings.transcriptionDictionaryProfiles).toEqual([]);
		expect(settings.transcriptionDictionaryProfileId).toBe('');
	});

	it('edits the first profile when the stored selection is None', () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: 'aorta' },
			],
			transcriptionDictionaryProfileId: '',
		});
		render('dictionary', settings);

		expect(settingRow('Profile name').text?.value).toBe('Medical');
		// "None" is a legitimate run default, so opening the editor must not
		// quietly turn it into a selection.
		expect(settings.transcriptionDictionaryProfileId).toBe('');
	});

	it('edits the first profile when the stored selection points at a removed one', () => {
		const settings = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Medical', terms: 'aorta' },
			],
			transcriptionDictionaryProfileId: 'gone',
		});
		render('dictionary', settings);

		expect(settingRow('Profile name').text?.value).toBe('Medical');
		expect(settingRow('Terms').text?.value).toBe('aorta');
	});

	it('drives the chapter guidance list with the same renderer', async () => {
		const settings = mergeSettings({
			transcriptionChapterPromptProfiles: [
				{ id: 'a', name: 'Interview', prompt: 'split by question' },
			],
			transcriptionChapterPromptProfileId: 'a',
		});
		render('chapter', settings);

		// Same rows, different copy and a different body field - proving the
		// two sections really share one implementation.
		expect(settingRow('Guidance prompt').text?.value).toBe(
			'split by question',
		);
		changeSetting('Guidance prompt', 'text', 'split by topic');
		expect(at(settings.transcriptionChapterPromptProfiles, 0).prompt).toBe(
			'split by topic',
		);

		await clickSettingButton('Profile', 'plus');
		expect(settings.transcriptionChapterPromptProfiles).toHaveLength(2);
		// The dictionary list is untouched: each kind writes only its own field.
		expect(settings.transcriptionDictionaryProfiles).toEqual(
			mergeSettings({}).transcriptionDictionaryProfiles,
		);
	});
});
