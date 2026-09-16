/**
 * Where the text a profile applies comes from, and how every screen says so.
 *
 * A profile's text is typed into the settings or read from a note, and a note
 * can go missing. Which of these holds decides what a run applies, so the
 * profile page, its catalogue entry, the picker of the profile in use, the
 * dialogs that pick a profile, and the notices a run or a rename gives all
 * state it. They state it through this class: the choice between typed text
 * and a note, the note lookup, and the wording live here, so no screen can
 * name the same source differently.
 * @module settings/ProfileTextSource
 */

import type { TFile, Vault } from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import { selectedProfile, type Profile, type ProfileKindId } from './profiles';
import { PROFILE_KINDS } from './profileKinds';

/** Where a profile's text can be chosen to come from. */
export type ProfileTextChoice = 'typed' | 'note';

/**
 * Where the text a profile applies comes from now. A missing note is a state a
 * note-backed profile falls into rather than a choice, which is why it is an
 * origin and not a {@link ProfileTextChoice}.
 */
export type ProfileTextOrigin = ProfileTextChoice | 'missingNote';

/** How a catalogue entry names each origin, worded to follow another part. */
const ORIGIN_SUMMARY: Record<ProfileTextOrigin, string> = {
	typed: 'typed text',
	note: 'note',
	missingNote: 'note missing',
};

/** Says where the text of a profile comes from, in one wording for all. */
export class ProfileTextSource {
	/** The label of each choice, as the Source row offers it. */
	static readonly CHOICES: Readonly<Record<ProfileTextChoice, string>> = {
		typed: 'Typed text',
		note: 'Note',
	};

	/**
	 * Profiles switched to a note that is not picked yet. Nothing is stored for
	 * them until a note is, so this belongs to the screen asking, and a fresh
	 * instance, or {@link ProfileTextSource.forgetChoices}, starts without it.
	 */
	private readonly awaitingNote = new Set<string>();

	/**
	 * @param vault - The vault a profile's note is looked up in
	 */
	constructor(private readonly vault: Vault) {}

	/**
	 * A description followed by a status on a line of its own. The own line is
	 * what makes the status read as the state of the choice rather than as more
	 * explanation of the row. Either part may be empty, and then the other is
	 * returned as the plain text it is.
	 *
	 * Static because the settings tree holds the status of an entry already and
	 * no vault to describe it with.
	 * @param desc - What the row is for
	 * @param status - The state the row's choice is in, or ''
	 * @returns The description to hand to the row
	 */
	static withStatus(desc: string, status: string): string | DocumentFragment {
		if (desc === '' || status === '') {
			return desc === '' ? status : desc;
		}
		return createFragment((fragment) => {
			fragment.append(desc, createDiv({ text: status }));
		});
	}

	/**
	 * The note a profile's text is read from, looked up at the moment of asking,
	 * so a note deleted since its last read is gone at once.
	 * @param profile - The profile being asked about
	 * @returns The note, or null for typed text and for a note that is missing
	 */
	note(profile: Profile): TFile | null {
		return profile.sourcePath === undefined
			? null
			: this.vault.getFileByPath(profile.sourcePath);
	}

	/**
	 * Where a profile's text comes from now.
	 * @param profile - The profile being asked about
	 * @returns The origin of the text a run would apply
	 */
	origin(profile: Profile): ProfileTextOrigin {
		if (profile.sourcePath === undefined) {
			return 'typed';
		}
		return this.note(profile) === null ? 'missingNote' : 'note';
	}

	/**
	 * What a profile's Source row shows as chosen: a note when one is bound or
	 * when the row was switched to one that is not picked yet.
	 * @param profile - The profile whose page is asked about
	 * @returns The choice the page is set to
	 */
	choice(profile: Profile): ProfileTextChoice {
		return profile.sourcePath !== undefined ||
			this.awaitingNote.has(profile.id)
			? 'note'
			: 'typed';
	}

	/**
	 * Sets a profile's Source row. Choosing a note stores nothing until a note
	 * is picked; choosing typed text detaches a bound note and leaves the text
	 * last read from it as the body, editable on the page.
	 * @param profile - The profile whose row was set
	 * @param choice - What the row was set to
	 * @returns Whether stored settings changed and have to be saved
	 */
	choose(profile: Profile, choice: ProfileTextChoice): boolean {
		if (choice === 'note') {
			if (profile.sourcePath === undefined) {
				this.awaitingNote.add(profile.id);
			}
			return false;
		}
		this.awaitingNote.delete(profile.id);
		if (profile.sourcePath === undefined) {
			return false;
		}
		delete profile.sourcePath;
		return true;
	}

	/**
	 * Points a profile at the note its Note row names. An empty row detaches
	 * the note, keeping its last text as the body, and leaves the choice on a
	 * note, because emptying the field is not choosing typed text.
	 * @param profile - The profile whose row was edited
	 * @param path - The note's vault path, or '' when the row was emptied
	 */
	bindNote(profile: Profile, path: string): void {
		if (path === '') {
			delete profile.sourcePath;
			this.awaitingNote.add(profile.id);
			return;
		}
		profile.sourcePath = path;
		this.awaitingNote.delete(profile.id);
	}

	/** Drops every switch to a note that was never picked. */
	forgetChoices(): void {
		this.awaitingNote.clear();
	}

	/**
	 * The line naming the text a profile applies, e.g. "Uses the text of
	 * Teams/Standup.md." It names where the text comes from and not how much it
	 * holds: a count shown beside the field it counts would lag behind every
	 * keystroke until the page is drawn again.
	 * @param profile - The profile, or undefined for None
	 * @returns The line, or '' when no profile applies
	 */
	status(profile: Profile | undefined): string {
		if (!profile) {
			return '';
		}
		const path = profile.sourcePath ?? '';
		switch (this.origin(profile)) {
			case 'typed':
				return this.awaitingNote.has(profile.id)
					? 'No note picked yet. Uses the text typed in the settings.'
					: 'Uses the text typed in the settings.';
			case 'note':
				return `Uses the text of ${path}.`;
			case 'missingNote':
				return `Uses the text last read from ${path}, which is missing.`;
		}
	}

	/**
	 * What a catalogue entry says about a profile without being opened, e.g.
	 * "In use, note, 12 names".
	 * @param profile - The profile the entry stands for
	 * @param inUse - Whether it is the profile of its kind a run applies
	 * @returns The entry's line
	 */
	summary(profile: Profile, inUse: boolean): string {
		const line = [
			inUse ? 'in use' : '',
			ORIGIN_SUMMARY[this.origin(profile)],
			PROFILE_KINDS.find((kind) => kind.id === profile.kind)?.summary(
				profile,
			) ?? '',
		]
			.filter((part) => part !== '')
			.join(', ');
		return line.charAt(0).toUpperCase() + line.slice(1);
	}

	/**
	 * A picker's description followed by the status of the profile it picked.
	 * @param desc - What the picker is for
	 * @param profile - The profile picked, or undefined for None
	 * @returns The description to hand to the picker's row
	 */
	describe(
		desc: string,
		profile: Profile | undefined,
	): string | DocumentFragment {
		return ProfileTextSource.withStatus(desc, this.status(profile));
	}

	/**
	 * The clause every notice about a missing note opens with, e.g. 'The note of
	 * profile "Standup" (Teams/Standup.md) is missing'. The caller finishes it
	 * with what that means for the action at hand.
	 * @param name - Name of the profile whose note is gone
	 * @param path - Vault path the profile names
	 * @returns The clause, without closing punctuation
	 */
	missingNote(name: string, path: string): string {
		return `The note of profile "${name}" (${path}) is missing`;
	}

	/**
	 * What a run is told about the profiles it reads whose note is gone.
	 *
	 * Such a profile keeps the text last read from its note: a note deleted,
	 * moved outside Obsidian, or not yet delivered by sync must not empty a
	 * glossary in the middle of a transcription. The run goes ahead on that
	 * text, and this names what it is running on. The caller names the kinds it
	 * reads by the same gates that decide whether it reads them, so a run is
	 * never told about a note it has no use for.
	 * @param settings - The active settings
	 * @param kinds - Kinds whose selected profile the run reads
	 * @returns The notice text, or null when every note is in place
	 */
	lostNotesNotice(
		settings: AudioRecorderSettings,
		kinds: readonly ProfileKindId[],
	): string | null {
		const lost = kinds.flatMap((kind) => {
			const profile = selectedProfile(settings, kind);
			return profile?.sourcePath !== undefined &&
				this.note(profile) === null
				? [{ name: profile.name, path: profile.sourcePath }]
				: [];
		});
		const [first] = lost;
		if (!first) {
			return null;
		}
		if (lost.length === 1) {
			return `${this.missingNote(first.name, first.path)}, so the text last read from it is used.`;
		}
		const named = lost
			.map(({ name, path }) => `"${name}" (${path})`)
			.join(', ');
		return `The notes of profiles ${named} are missing, so the text last read from them is used.`;
	}
}
