/**
 * Tests for how a recording was reached and what that allows: which delete
 * each surface offers, which note a dialog opened from it writes into, and
 * how the facts two menu handlers found for one click combine.
 * @module tests/unit/RecordingOrigin.test
 */

import type { Editor } from 'obsidian';
import {
	RecordingOrigin,
	type LinkLocation,
} from 'src/actions/file/RecordingOrigin';
import { createFile } from '../helpers/createApp';
import { partial } from '../helpers/doubles';

const note = createFile('Meetings/standup.md');

const link: LinkLocation = {
	editor: partial<Editor>({}),
	subpath: '',
	line: 2,
	start: 0,
	end: 17,
};

describe('what each way of reaching a recording allows', () => {
	it.each([
		{
			reached: 'on its own',
			origin: RecordingOrigin.direct(),
			plain: true,
			withLinks: false,
			dialogNote: undefined,
		},
		{
			reached: 'from buttons beside the note',
			origin: RecordingOrigin.besideNote(),
			plain: false,
			withLinks: false,
			dialogNote: undefined,
		},
		{
			reached: 'as a recording of the active note',
			origin: RecordingOrigin.inNote(note),
			plain: false,
			withLinks: true,
			dialogNote: note,
		},
		{
			reached: 'through a link in a note',
			origin: RecordingOrigin.atLink(note, link, false),
			plain: false,
			withLinks: true,
			dialogNote: note,
		},
		{
			reached: 'through a link in an editor that shows no note',
			origin: RecordingOrigin.atLink(null, link, false),
			plain: false,
			withLinks: true,
			dialogNote: null,
		},
		{
			reached: 'at a moment through a link',
			origin: RecordingOrigin.atLink(note, link, true),
			plain: false,
			withLinks: false,
			dialogNote: note,
		},
		{
			reached: 'through a link whose place is not known',
			origin: RecordingOrigin.throughLink(null, null, false),
			plain: false,
			withLinks: true,
			dialogNote: null,
		},
		{
			reached: 'from a player embedded at a timestamp',
			origin: RecordingOrigin.throughLink(note, null, true),
			plain: false,
			withLinks: false,
			dialogNote: note,
		},
		{
			reached: 'named alone on the command line',
			origin: RecordingOrigin.named(null),
			plain: true,
			withLinks: false,
			dialogNote: null,
		},
		{
			reached: 'named with its note on the command line',
			origin: RecordingOrigin.named(note),
			plain: false,
			withLinks: true,
			dialogNote: note,
		},
	])(
		'answers for a recording reached $reached',
		({ origin, plain, withLinks, dialogNote }) => {
			expect({
				plain: origin.offersPlainDelete(),
				withLinks: origin.offersLinkDelete(),
				dialogNote: origin.noteForDialog(),
			}).toEqual({ plain, withLinks, dialogNote });
		},
	);

	it('keeps the note, the link and the moment it was reached at', () => {
		const origin = RecordingOrigin.atLink(note, link, true);

		expect([origin.note, origin.link, origin.atMoment]).toEqual([
			note,
			link,
			true,
		]);
	});
});

describe('what two handlers of one menu found together', () => {
	// Obsidian raises the editor menu and the link's own menu for one click,
	// in an order nothing guarantees; either order has to end the same.
	const fromEditor = RecordingOrigin.atLink(note, link, false);
	const fromLinkMenu = RecordingOrigin.throughLink(null, null, true);

	it.each([
		{ order: 'editor menu first', merged: fromEditor.merge(fromLinkMenu) },
		{ order: 'link menu first', merged: fromLinkMenu.merge(fromEditor) },
	])('holds every fact with the $order', ({ merged }) => {
		expect({
			note: merged.note,
			link: merged.link,
			atMoment: merged.atMoment,
			plain: merged.offersPlainDelete(),
			withLinks: merged.offersLinkDelete(),
			dialogNote: merged.noteForDialog(),
		}).toEqual({
			note,
			link,
			atMoment: true,
			plain: false,
			withLinks: false,
			dialogNote: note,
		});
	});

	it('keeps the note the first handler found', () => {
		const other = createFile('Meetings/retro.md');

		const merged = RecordingOrigin.inNote(note).merge(
			RecordingOrigin.inNote(other),
		);

		expect(merged.note).toBe(note);
	});

	it('stays offered on its own when nothing more was found', () => {
		const merged = RecordingOrigin.direct().merge(RecordingOrigin.direct());

		expect(merged.offersPlainDelete()).toBe(true);
	});
});
