/**
 * The profile-manager settings section: one renderer shared by the dictionary
 * glossaries and the chapter guidance prompts, which differ only in their copy
 * and in what their body field is called.
 * @module settings/sections/profileManagerSection
 */

import { Setting } from 'obsidian';
import {
	addHeading,
	addText,
	addTextArea,
	type SettingsSectionContext,
} from '../settingControls';
import {
	addAndSelectProfile,
	editingProfileId,
	findProfile,
	removeAndReselectProfile,
	type Profile,
	type ProfileList,
} from '../profiles';
import { DICTIONARY_PROFILES } from '../dictionaryProfiles';
import { CHAPTER_PROMPT_PROFILES } from '../chapterPromptProfiles';

/**
 * How one profile-manager section reads: its heading, the selector's help text,
 * and the two editable fields of the selected profile. Everything else about
 * the section - selecting, adding, removing, falling back when the selection is
 * stale - is identical for every profile kind and lives in
 * {@link renderProfileManager}.
 */
interface ProfileManagerCopy<T extends Profile> {
	/** Section heading, e.g. "Dictionary profiles". */
	heading: string;
	/** Description on the selector row. */
	selectorDesc: string;
	/** Default name given to a profile created from the add button. */
	newProfileName: string;
	/** Label and description of the profile's body field. */
	bodyName: string;
	bodyDesc: string;
	/** Reads the profile's body text. */
	body: (profile: T) => string;
	/** Writes the profile's body text. */
	setBody: (profile: T, value: string) => void;
}

/**
 * Renders a profile manager: a selector with add/remove buttons plus an editor
 * for the selected profile's name and body. Shared by the dictionary and
 * chapter-guidance sections, which differ only in their copy and in what their
 * body field is called - the selection, fallback, and list mechanics are
 * identical and were previously duplicated line for line.
 * @param ctx - The section context (container plus save/rerender hooks)
 * @param list - Where this kind of profile lives in settings
 * @param copy - The section's headings, descriptions, and body field
 */
function renderProfileManager<T extends Profile>(
	ctx: SettingsSectionContext,
	list: ProfileList<T>,
	copy: ProfileManagerCopy<T>,
): void {
	const s = ctx.settings;
	const profiles = list.get(s);
	addHeading(ctx, copy.heading);

	// Edit the persisted run selection when it is a real profile, otherwise the
	// first profile, so the editor always shows something without silently
	// changing a stored "none" default.
	const editingId = editingProfileId(profiles, list.selectedId(s));

	const selector = new Setting(ctx.containerEl)
		.setName('Profile')
		.setDesc(copy.selectorDesc);
	if (profiles.length > 0) {
		selector.addDropdown((dropdown) => {
			for (const profile of profiles) {
				dropdown.addOption(profile.id, profile.name);
			}
			dropdown.setValue(editingId).onChange(async (id) => {
				// Selecting a profile to edit also makes it the run default.
				list.setSelectedId(s, id);
				await ctx.save();
				ctx.rerender();
			});
		});
	}
	selector.addExtraButton((button) =>
		button
			.setIcon('plus')
			.setTooltip('Add profile')
			.onClick(async () => {
				// Selects the new profile so its fields open for editing.
				addAndSelectProfile(list, s, copy.newProfileName);
				await ctx.save();
				ctx.rerender();
			}),
	);
	if (profiles.length > 0) {
		selector.addExtraButton((button) =>
			button
				.setIcon('trash')
				.setTooltip('Remove profile')
				.onClick(async () => {
					// Falls back to the first remaining profile, or to none.
					removeAndReselectProfile(list, s, editingId);
					await ctx.save();
					ctx.rerender();
				}),
		);
	}

	const selected = findProfile(profiles, editingId);
	if (!selected) {
		// Empty list: the Add button above creates the first profile.
		return;
	}
	addText(ctx, {
		name: 'Profile name',
		// Name and body edits mutate the live profile and save debounced, so the
		// caret is kept; the selector label refreshes on the next re-render.
		get: () => selected.name,
		set: (v) => (selected.name = v),
	});
	addTextArea(ctx, {
		name: copy.bodyName,
		desc: copy.bodyDesc,
		get: () => copy.body(selected),
		set: (v) => copy.setBody(selected, v),
		rows: 6,
	});
}

/**
 * The chapter-guidance profile manager. The selected profile's prompt is
 * appended to the fixed chapter base prompt at generation time; the base rules
 * and the JSON contract are never edited here, so a customized or added profile
 * cannot break response parsing.
 * @param ctx - The section context
 */
export function renderChapterPromptProfiles(ctx: SettingsSectionContext): void {
	renderProfileManager(ctx, CHAPTER_PROMPT_PROFILES, {
		heading: 'Chapter guidance profiles',
		selectorDesc:
			'Named prompts describing how to divide a recording into chapters. ' +
			'Pick one to steer chaptering for a given case; the guidance is ' +
			'appended to the built-in chapter prompt. The response format is ' +
			'fixed and not part of a profile, so editing one is safe.',
		newProfileName: 'New profile',
		bodyName: 'Guidance prompt',
		bodyDesc:
			'How to divide the recording into chapters. Appended to the fixed base prompt; leave blank for the base behavior only.',
		body: (profile) => profile.prompt,
		setBody: (profile, value) => (profile.prompt = value),
	});
}

/**
 * The dictionary-profile manager. The editor is engine-independent (a profile
 * is just stored text); whether and how the terms bias recognition is decided
 * at transcription time by planDictionaryBias. The per-run profile (or None) is
 * chosen in the Transcribe dialog and remembered.
 * @param ctx - The section context
 */
export function renderDictionaryProfiles(ctx: SettingsSectionContext): void {
	renderProfileManager(ctx, DICTIONARY_PROFILES, {
		heading: 'Dictionary profiles',
		selectorDesc:
			'Named glossaries of names, abbreviations, and domain terms. Pick one, ' +
			'or None, per run in the Transcribe dialog; the last pick is remembered. ' +
			'Whether the terms bias recognition depends on the selected engine, and ' +
			'for Deepgram on the model; a run reports any terms it could not apply.',
		newProfileName: 'New profile',
		bodyName: 'Terms',
		bodyDesc:
			'One term per line. A term may contain spaces; blank lines and case-insensitive duplicates are ignored.',
		body: (profile) => profile.terms,
		setBody: (profile, value) => (profile.terms = value),
	});
}
