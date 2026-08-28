/**
 * The stored lists a prompt or a glossary is chosen from.
 *
 * Every profile kind renders the same way, so one page shape and one group
 * shape serve all of them, and the kind supplies only its texts and its
 * accessors.
 * @module settings/sections/profilesSection
 */

import type { ProfileSection } from '../profileKinds';
import type { AudioRecorderSettings } from '../settingsSchema';
import {
	type ProfileCatalogue,
	type ProfileEntry,
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
	STACKED_TEXT_CLASS,
} from './context';
import { profileControlKey } from './controlKeys';
import { addItemRow, nameFilter } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/** Visible lines a profile body field opens with. */
const PROFILE_BODY_ROWS = 8;

/**
 * One saved profile, as a page of its own.
 *
 * A profile is an entity, not a setting: it has a name, a body that is edited
 * in paragraphs, and a lifecycle. Giving each one a page means the collection
 * reads as a list of names and nothing else, and every field belongs to the
 * profile whose page it is on rather than to "whichever one is selected".
 *
 * The name is edited through a dialog rather than a field on the page, because
 * the framework addresses an open page by its name: renaming under itself
 * leaves the page unresolvable, so a rename applies and returns to the list.
 * @param catalogue - The profile kind being declared
 * @param entry - The profile this page belongs to
 */
function profilePage(
	catalogue: ProfileCatalogue,
	entry: ProfileEntry,
): SettingGroupItem {
	return {
		type: 'page',
		name: entry.name,
		displayValue: entry.summary,
		items: [
			{
				type: 'group',
				cls: SETTINGS_SECTION_CLASS,
				items: [
					{
						name: catalogue.selectionName,
						desc: catalogue.selectionDesc,
						control: {
							type: 'toggle',
							key: profileControlKey(
								catalogue.selectionKey,
								entry.id,
							),
						},
					},
				],
			},
			{
				// The body is a multi-line editor, which is laid out across the
				// whole row and therefore in a block of its own.
				type: 'group',
				cls: `${SETTINGS_SECTION_CLASS} ${STACKED_TEXT_CLASS}`,
				items: [
					{
						name: catalogue.bodyName,
						desc: catalogue.bodyDesc,
						control: {
							type: 'textarea',
							key: profileControlKey(catalogue.bodyKey, entry.id),
							rows: PROFILE_BODY_ROWS,
						},
					},
				],
			},
			{
				type: 'group',
				cls: SETTINGS_SECTION_CLASS,
				items: [
					{
						name: 'Rename profile',
						desc: 'The name this profile is picked by. Applying a new one returns to the list, where it is shown.',
						action: (): void => {
							catalogue.rename(entry.id);
						},
					},
					{
						name: 'Delete profile',
						desc: 'Removes this profile and returns to the list.',
						action: (): void => {
							catalogue.remove(entry.id);
						},
					},
				],
			},
		],
	};
}

/**
 * A profile catalogue: the saved profiles as a list of pages, behind a single
 * entry that names the one in use.
 *
 * A glossary runs to dozens of profiles and every one of them was a row on the
 * transcription page, pushing the settings after it off the screen. On a page
 * of their own they cost one row, which reads the way the style guide wants a
 * collection to read: the name of the thing, the value in use, and a way in.
 * @param settings - Live settings, read by the predicates
 * @param catalogue - The profile kind being declared
 * @param declareAddRow - Whether this tree owes the list a labelled add row,
 * which is the case wherever the renderer draws only a plus icon
 */
function profileGroups(
	settings: AudioRecorderSettings,
	catalogue: ProfileCatalogue,
	declareAddRow: boolean,
): SettingGroupItem[] {
	const entries = catalogue.entries(settings);
	const visible = (): boolean => catalogue.visible(settings);
	const selectedName = (): string => {
		// The selection lives in the profile store, not in a settings field of
		// its own, so the catalogue is what answers which profile is in use.
		const selected = catalogue.selectedId(settings);
		return (
			catalogue.entries(settings).find((entry) => entry.id === selected)
				?.name ?? 'None'
		);
	};
	const add = (): void => {
		catalogue.add();
	};
	const selectionRow: SettingGroupItem = {
		name: catalogue.selectionName,
		aliases: ['profile', 'preset'],
		desc: catalogue.selectionDesc,
		visible,
		control: {
			type: 'dropdown',
			key: catalogue.selectionKey,
			// None is a real answer: a run then applies no profile of this kind.
			options: {
				'': 'None',
				...Object.fromEntries(
					entries.map((entry) => [entry.id, entry.name]),
				),
			},
		},
	};
	return [
		selectionRow,
		{
			type: 'page',
			name: catalogue.heading,
			desc: catalogue.selectorDesc,
			displayValue: selectedName,
			visible,
			items: [
				{
					type: 'list',
					cls: SETTINGS_SECTION_CLASS,
					emptyState: 'No profiles yet. Add one to start.',
					search: nameFilter('Filter profiles'),
					addItem: { name: 'Add profile', action: add },
					// The order is the order the picker offers, so a catalogue
					// grown one profile at a time can be arranged rather than
					// read in the order it happened to be created in. Indices
					// address the items declared below, which is the stored
					// order - the same contract the model catalogue's onDelete
					// already relies on.
					onReorder: (from, to): void => {
						catalogue.reorder(from, to);
					},
					items: entries.map((entry) =>
						profilePage(catalogue, entry),
					),
				},
				// Beside the list rather than in it: a row inside would be
				// filtered away by the list's own search, exactly when an empty
				// result makes adding one the obvious next move.
				...(declareAddRow
					? [
							addItemRow(
								'Add profile',
								'Creates an empty profile at the end of the list.',
								add,
							),
						]
					: []),
			],
		},
	];
}

/**
 * Every catalogue one block of the settings shows, each as the same pair: the
 * row that picks the profile in use, and the entry that manages them.
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block being built
 */
export function profileCatalogues(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingGroupItem[] {
	return ctx.profiles
		.filter((catalogue) => catalogue.section === section)
		.flatMap((catalogue) =>
			profileGroups(ctx.settings, catalogue, ctx.declareListAddRow),
		);
}
