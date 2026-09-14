/**
 * Keeps the body of every note-backed profile in step with its note.
 *
 * Every reader of a profile body is synchronous: the resolvers a run calls, the
 * summary a catalogue entry shows, the estimate a dialog prints before a run.
 * Reading a note is asynchronous. The store owns that one asynchronous part: it
 * reads the note a profile names and writes the text into the profile's `body`,
 * the field every reader already reads, so none of them changes and the copy
 * kept in data.json still answers before the first read of a session.
 * @module settings/ProfileNoteStore
 */

import { TFile, debounce, getFrontMatterInfo } from 'obsidian';
import type { App, Plugin, TAbstractFile, Vault } from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import { selectedProfile, type Profile } from './profiles';
import { PROFILE_KINDS, type ProfileSection } from './profileKinds';
import {
	mergeParticipantNames,
	parseParticipantBody,
} from '../speakers/participantRoster';
import { PLUGIN_LOG_PREFIX } from '../constants';

/**
 * Quiet period before note edits are written to data.json, in milliseconds.
 * Obsidian saves an open note every couple of seconds while it is typed into,
 * and each save is a `modify`; data.json follows once the typing pauses.
 */
const PERSIST_DEBOUNCE_MS = 2000;

/** The bullet a list line opens with, repeated by the names appended after it. */
const BULLET_LINE = /^\s*([-*+])\s/;

/**
 * The text of a note below its frontmatter. The frontmatter describes the file
 * (its tags, its aliases) and is no part of the glossary or prompt under it.
 * @param content - The note as read
 * @returns Everything after the frontmatter block, or the whole note
 */
function noteBody(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
}

/**
 * Reads note-backed profiles into their bodies and follows their notes around
 * the vault.
 */
export class ProfileNoteStore {
	/**
	 * The path each profile's body was last read from. Keyed by the profile
	 * object: a settings reload builds new objects, whose bodies came from
	 * data.json and may be older than the notes, and because no key is shared
	 * with them the next reconcile reads every one of them again.
	 */
	private readonly readFrom = new WeakMap<Profile, string>();

	/** Writes data.json once a burst of note saves has settled. */
	private readonly persistSoon = debounce(
		() => {
			void this.persist();
		},
		PERSIST_DEBOUNCE_MS,
		true,
	);

	/**
	 * @param app - Obsidian App instance
	 * @param getSettings - Returns the live settings, which a reload replaces
	 * @param persist - Saves the settings after a body or a path changed
	 */
	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly persist: () => Promise<void>,
	) {}

	/**
	 * Reads every note-backed profile once the vault is loaded, then follows
	 * the vault. The subscriptions wait for the layout because Obsidian reports
	 * every existing file as created while it loads the vault, and the reconcile
	 * that runs at that moment reads whatever those events would have.
	 * @param plugin - Owning plugin, which releases the subscriptions on unload
	 */
	register(plugin: Plugin): void {
		this.app.workspace.onLayoutReady(() => {
			const { vault } = this.app;
			// A note saved, or a note arriving: created, restored from the
			// trash, or delivered by sync after a read that found it missing.
			const reread = (file: TAbstractFile): void => {
				if (!(file instanceof TFile)) {
					return;
				}
				void this.readNote(file.path).then((changed) => {
					if (changed) {
						this.persistSoon();
					}
				});
			};
			plugin.registerEvent(vault.on('modify', reread));
			plugin.registerEvent(vault.on('create', reread));
			plugin.registerEvent(
				vault.on('rename', (file, oldPath) => {
					this.repoint(oldPath, file.path);
				}),
			);
			void this.reconcile().then((changed) =>
				changed ? this.persist() : undefined,
			);
		});
	}

	/**
	 * Reads every note-backed profile whose body was not read from the path it
	 * names now: at load, after a note was picked in the settings, and after a
	 * reload of the settings. A note that cannot be found leaves the body as it
	 * is and is looked for again next time.
	 *
	 * Nothing is saved here, so the call is safe from inside a settings save.
	 * @returns Whether any body changed
	 */
	async reconcile(): Promise<boolean> {
		const paths = new Set(
			this.getSettings().profiles.flatMap((profile) =>
				profile.sourcePath !== undefined &&
				this.readFrom.get(profile) !== profile.sourcePath
					? [profile.sourcePath]
					: [],
			),
		);
		const results = await Promise.all(
			[...paths].map((path) => this.readNote(path)),
		);
		return results.includes(true);
	}

	/**
	 * Reads one note into every profile that names it.
	 * @param path - Vault path of the note
	 * @returns Whether any body changed
	 */
	private async readNote(path: string): Promise<boolean> {
		const profiles = this.getSettings().profiles.filter(
			(profile) => profile.sourcePath === path,
		);
		const file = this.app.vault.getFileByPath(path);
		if (profiles.length === 0 || !file) {
			return false;
		}
		let content: string;
		try {
			content = await this.app.vault.cachedRead(file);
		} catch (error) {
			// Deleted or locked between the lookup and the read: the body
			// stays, and the next event or reconcile tries again.
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the profile note ${path}.`,
				error,
			);
			return false;
		}
		const body = noteBody(content);
		let changed = false;
		for (const profile of profiles) {
			// A note picked in the settings while this one was being read
			// replaces it; the text read here no longer belongs to the profile.
			if (profile.sourcePath !== path) {
				continue;
			}
			this.readFrom.set(profile, path);
			if (profile.body !== body) {
				profile.body = body;
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Follows a note, or a folder holding notes, that Obsidian renamed or moved.
	 * Saved at once rather than with the note edits: a path left stale on disk
	 * is a profile that finds no note at the next load.
	 * @param oldPath - Path before the rename
	 * @param newPath - Path after it
	 */
	private repoint(oldPath: string, newPath: string): void {
		const insideFolder = `${oldPath}/`;
		let moved = false;
		for (const profile of this.getSettings().profiles) {
			const path = profile.sourcePath;
			if (
				path === undefined ||
				(path !== oldPath && !path.startsWith(insideFolder))
			) {
				continue;
			}
			const next = newPath + path.slice(oldPath.length);
			profile.sourcePath = next;
			// The same text under another name: nothing to read again.
			if (this.readFrom.get(profile) === path) {
				this.readFrom.set(profile, next);
			}
			moved = true;
		}
		if (moved) {
			void this.persist();
		}
	}
}

/**
 * Adds names to a roster kept in a note, so a name applied in the rename dialog
 * is suggested next time exactly as it is for a roster typed into the settings.
 *
 * The note is the user's document, so it is appended to and never rewritten:
 * its headings, comments, and order stay as they are. Each new name goes on a
 * line of its own after the last line of text, opened with the bullet that line
 * uses, so a bulleted roster stays one list. The names already in the note are
 * read inside the same atomic write, so an edit landing meanwhile is neither
 * lost nor duplicated. The profile's body follows through the `modify` the
 * write raises.
 * @param vault - The vault holding the note
 * @param file - The note the roster is read from
 * @param names - Names to add
 * @returns Whether any name was new
 */
export async function appendParticipantsToNote(
	vault: Vault,
	file: TFile,
	names: readonly string[],
): Promise<boolean> {
	let added = false;
	await vault.process(file, (content) => {
		const current = parseParticipantBody(noteBody(content));
		const fresh = mergeParticipantNames(current, names).slice(
			current.length,
		);
		if (fresh.length === 0) {
			return content;
		}
		added = true;
		const text = content.trimEnd();
		const lastLine = text.slice(text.lastIndexOf('\n') + 1);
		const bullet = BULLET_LINE.exec(lastLine)?.[1];
		const prefix = bullet === undefined ? '' : `${bullet} `;
		const lines = fresh.map((name) => `${prefix}${name}`).join('\n');
		return `${text}${text === '' ? '' : '\n'}${lines}\n`;
	});
	return added;
}

/**
 * What a run is told about the profiles it applies whose note is gone.
 *
 * Such a profile keeps the text last read from its note: a note deleted, moved
 * outside Obsidian, or not yet delivered by sync must not empty a glossary in
 * the middle of a transcription. The run goes ahead on that text, and this
 * names what it is running on.
 * @param vault - The vault the notes are looked up in
 * @param settings - The active settings
 * @param sections - Blocks of the settings whose kinds this run applies
 * @returns The notice text, or null when every note is in place
 */
export function lostProfileSourceNotice(
	vault: Vault,
	settings: AudioRecorderSettings,
	sections: readonly ProfileSection[],
): string | null {
	const lost = PROFILE_KINDS.filter(
		(kind) => sections.includes(kind.section) && kind.visible(settings),
	).flatMap((kind) => {
		const profile = selectedProfile(settings, kind.id);
		return profile?.sourcePath !== undefined &&
			vault.getFileByPath(profile.sourcePath) === null
			? [`"${profile.name}" (${profile.sourcePath})`]
			: [];
	});
	if (lost.length === 0) {
		return null;
	}
	return lost.length === 1
		? `The note of profile ${lost.join('')} is missing, so the text last read from it is used.`
		: `The notes of profiles ${lost.join(', ')} are missing, so the text last read from them is used.`;
}
