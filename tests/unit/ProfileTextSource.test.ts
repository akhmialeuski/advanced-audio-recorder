/**
 * Tests the one class that says where the text of a profile comes from: the
 * note lookup, the Source choice and its pending switch to a note, the line the
 * profile page and the pickers show, the catalogue entry line, and the notices
 * about a note that is gone or could not be read.
 * @module tests/unit/ProfileTextSource.test
 */

import { App } from 'obsidian';
import {
	createProfile,
	noSelectedProfiles,
	type Profile,
} from 'src/settings/profiles';
import { ProfileTextSource } from 'src/settings/ProfileTextSource';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { asMockVault } from '../helpers/obsidianMock';

/** The note the note-backed rosters below are read from. */
const NOTE = 'Teams/Standup.md';

/** The line a profile typed into the settings shows. */
const TYPED = 'Uses the text typed in the settings.';

describe('ProfileTextSource', () => {
	let app: App;
	let source: ProfileTextSource;

	beforeEach(() => {
		app = new App();
		asMockVault(app.vault).seed([
			{ path: NOTE, content: '- Alex\n- Maria' },
		]);
		source = new ProfileTextSource(app.vault);
	});

	/** A roster of two names, typed in or read from the seeded note. */
	const roster = (sourcePath?: string): Profile => ({
		...createProfile('participants', 'Standup', 'Alex\nMaria'),
		...(sourcePath === undefined ? {} : { sourcePath }),
	});

	describe('origin', () => {
		it('tells typed text, a note, and a note that is gone apart', () => {
			expect(source.origin(roster())).toBe('typed');
			expect(source.origin(roster(NOTE))).toBe('note');
			expect(source.note(roster(NOTE))?.path).toBe(NOTE);
			expect(source.note(roster())).toBeNull();

			asMockVault(app.vault).forget(NOTE);

			// Looked up when asked, so a deletion shows before any re-read.
			expect(source.origin(roster(NOTE))).toBe('missingNote');
		});

		it('tells a note that could not be read from one that is gone', () => {
			const profile = roster(NOTE);
			const reader = new ProfileTextSource(
				app.vault,
				new Set([profile.id]),
			);

			expect(reader.origin(profile)).toBe('unreadNote');
			// Only the instance that read the notes knows a read failed.
			expect(source.origin(profile)).toBe('note');

			asMockVault(app.vault).forget(NOTE);

			// A note gone since the read is gone, whatever the read met.
			expect(reader.origin(profile)).toBe('missingNote');
		});
	});

	describe('choice', () => {
		it('holds a switch to a note until a note is picked, storing nothing', () => {
			const profile = roster();

			expect(source.choose(profile, 'note')).toBe(false);

			expect(profile.sourcePath).toBeUndefined();
			expect(source.choice(profile)).toBe('note');
			expect(source.status(profile)).toBe(`No note picked yet. ${TYPED}`);

			source.bindNote(profile, NOTE);

			expect(profile.sourcePath).toBe(NOTE);
			expect(source.status(profile)).toBe(`Uses the text of ${NOTE}.`);
		});

		it('keeps the choice on a note when its field is emptied', () => {
			const profile = roster(NOTE);

			source.bindNote(profile, '');

			expect('sourcePath' in profile).toBe(false);
			expect(source.choice(profile)).toBe('note');
		});

		it('detaches a bound note on a choice of typed text, and says it stored that', () => {
			const profile = roster(NOTE);

			expect(source.choose(profile, 'note')).toBe(false);
			expect(source.choose(profile, 'typed')).toBe(true);

			expect('sourcePath' in profile).toBe(false);
			expect(source.choice(profile)).toBe('typed');
			// Typed text chosen again changes nothing stored.
			expect(source.choose(profile, 'typed')).toBe(false);
		});

		it('forgets every switch that was never picked', () => {
			const profile = roster();
			source.choose(profile, 'note');

			source.forgetChoices();

			expect(source.choice(profile)).toBe('typed');
			// A fresh instance starts without the switch as well.
			source.choose(profile, 'note');
			expect(new ProfileTextSource(app.vault).choice(profile)).toBe(
				'typed',
			);
		});
	});

	describe('status', () => {
		it('names where the text comes from', () => {
			expect(source.status(roster())).toBe(TYPED);
			expect(source.status(roster(NOTE))).toBe(
				`Uses the text of ${NOTE}.`,
			);

			asMockVault(app.vault).forget(NOTE);

			expect(source.status(roster(NOTE))).toBe(
				`Uses the text last read from ${NOTE}, which is missing.`,
			);
		});

		it('names the text last read from a note that could not be read', () => {
			const profile = roster(NOTE);

			expect(
				new ProfileTextSource(app.vault, new Set([profile.id])).status(
					profile,
				),
			).toBe(
				`Uses the text last read from ${NOTE}, which could not be read.`,
			);
		});

		it('says nothing for None', () => {
			expect(source.status(undefined)).toBe('');
		});
	});

	describe('summary', () => {
		it('puts use, origin, and contents in one line', () => {
			expect(source.summary(roster(), false)).toBe('Typed text, 2 names');
			expect(source.summary(roster(NOTE), true)).toBe(
				'In use, note, 2 names',
			);

			asMockVault(app.vault).forget(NOTE);

			expect(source.summary(roster(NOTE), false)).toBe(
				'Note missing, 2 names',
			);
		});

		it('counts nothing for a kind no descriptor describes', () => {
			const retired = { ...roster(), kind: 'retired' as never };

			expect(source.summary(retired, false)).toBe('Typed text');
		});
	});

	describe('a picker description', () => {
		const DESC = 'Names saved with this recording.';

		it('puts the status of the picked profile on a line of its own', () => {
			const desc = source.describe(
				DESC,
				roster(NOTE),
			) as DocumentFragment;

			expect(desc.firstChild?.textContent).toBe(DESC);
			expect(desc.lastChild?.nodeName).toBe('DIV');
			expect(desc.lastChild?.textContent).toBe(
				`Uses the text of ${NOTE}.`,
			);
		});

		it('leaves the description as plain text for None', () => {
			expect(source.describe(DESC, undefined)).toBe(DESC);
		});

		it('gives the status alone to a row with no description', () => {
			expect(ProfileTextSource.withStatus('', TYPED)).toBe(TYPED);
		});
	});

	describe('typedTextQuestion', () => {
		it('offers an empty note the text typed for the profile', () => {
			expect(
				source.typedTextQuestion(roster(), NOTE, '\n\n'),
			).toMatchObject({
				confirmText: 'Move text',
				moveIntoNote: true,
			});
		});

		it('asks before the text of a note replaces the typed text', () => {
			const question = source.typedTextQuestion(
				roster(),
				NOTE,
				'- Alex\n- Maria\n- Ivan',
			);

			expect(question).toMatchObject({
				confirmText: 'Use the note',
				moveIntoNote: false,
			});
			expect(question?.message).toContain(NOTE);
		});

		it('asks nothing when no typed text would be lost', () => {
			// A profile read from a note keeps its text in that note, an empty
			// body has nothing to lose, and a note holding the typed text
			// already loses nothing by being read.
			expect(
				source.typedTextQuestion(roster(NOTE), NOTE, '- Ivan'),
			).toBeNull();
			expect(
				source.typedTextQuestion(
					createProfile('participants', 'Empty'),
					NOTE,
					'- Ivan',
				),
			).toBeNull();
			expect(
				source.typedTextQuestion(roster(), NOTE, 'Alex\nMaria\n'),
			).toBeNull();
		});
	});

	describe('lostNotesNotice', () => {
		const glossary = (): Profile => ({
			...createProfile('dictionary', 'Terms', 'Kubernetes'),
			sourcePath: 'Glossaries/Terms.md',
		});
		const settings = {
			...DEFAULT_SETTINGS,
			profiles: [glossary(), roster(NOTE)],
		};
		settings.selectedProfileIds = {
			...noSelectedProfiles(),
			dictionary: settings.profiles[0]?.id ?? '',
			participants: settings.profiles[1]?.id ?? '',
		};

		it('names every profile a run reads whose note is gone', () => {
			asMockVault(app.vault).forget(NOTE);

			expect(source.lostNotesNotice(settings, ['participants'])).toBe(
				`The note of profile "Standup" (${NOTE}) is missing, so the text last read from it is used.`,
			);
			expect(
				source.lostNotesNotice(settings, [
					'dictionary',
					'participants',
				]),
			).toBe(
				`The notes of profiles "Terms" (Glossaries/Terms.md), "Standup" (${NOTE}) are missing, so the text last read from them is used.`,
			);
		});

		it('says nothing while the notes a run reads are in place', () => {
			expect(
				source.lostNotesNotice(settings, ['participants']),
			).toBeNull();
		});

		it('names a note the run could not read apart from a note that is gone', () => {
			// The glossary note is in the vault and its read failed; the roster
			// note is gone.
			asMockVault(app.vault).seed([
				{ path: 'Glossaries/Terms.md', content: '- Kubernetes' },
			]);
			asMockVault(app.vault).forget(NOTE);
			const reader = new ProfileTextSource(
				app.vault,
				new Set([settings.profiles[0]?.id ?? '']),
			);

			expect(
				reader.lostNotesNotice(settings, [
					'dictionary',
					'participants',
				]),
			).toBe(
				`The note of profile "Standup" (${NOTE}) is missing, so the text last read from it is used. ` +
					'The note of profile "Terms" (Glossaries/Terms.md) could not be read, so the text last read from it is used.',
			);
		});
	});
});
