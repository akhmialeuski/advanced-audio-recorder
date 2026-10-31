/**
 * A vault of recordings and the notes that embed them, as the action targets
 * are found in: the shared stateful vault, a metadata cache that reports each
 * note's embeds where its text has them, link resolution by path, name or
 * base name, and an active file. What the palette, the menus and the command
 * line resolve a recording from is all here, so a suite only says which
 * recordings, which notes, and what is open.
 * @module tests/helpers/recordingVault
 */

import { App, TFile } from 'obsidian';
import type { ActionServices } from 'src/actions/core/actionServices';
import type { FileContext } from 'src/actions/file/FileContext';
import { RecordingOrigin } from 'src/actions/file/RecordingOrigin';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { asMockApp } from './obsidianMock';
import { commonActionServices } from './doubles';

/** What a suite says about its vault. */
export interface RecordingVaultOptions {
	/** Vault paths of the audio files. */
	readonly recordings?: readonly string[];
	/**
	 * Each note's path, and the recordings it embeds in the order it does -
	 * or the note's text itself, whose links and embeds the cache reports.
	 */
	readonly notes?: Readonly<Record<string, readonly string[] | string>>;
	/** Path of the active file, or none. */
	readonly active?: string;
	/** Plugin settings on top of the defaults. */
	readonly settings?: Partial<AudioRecorderSettings>;
}

/** The vault, and the services every action is given over it. */
export interface RecordingVault {
	/** The app holding the vault. */
	readonly app: App;
	/** Services over the app, with the shared doubles for the rest. */
	readonly services: ActionServices & ReturnType<typeof commonActionServices>;
	/** The plugin settings the services hand out. */
	readonly settings: AudioRecorderSettings;
	/**
	 * A file of the vault by path.
	 * @param path - Its vault path
	 */
	file(path: string): TFile;
	/**
	 * A recording as a file action is handed it.
	 * @param recording - Its vault path
	 * @param note - The note it was reached through, if it was
	 */
	fileContext(recording: string, note?: string): FileContext;
}

/** One embed line of a note, as the note's text holds it. */
const embedLine = (path: string): string =>
	`![[${path.split('/').pop() ?? path}]]`;

/**
 * A note's text: a heading, then one embed per recording, a blank line
 * between them.
 * @param recordings - What the note embeds
 */
export function noteText(recordings: readonly string[]): string {
	return ['# Meeting', ...recordings.map(embedLine)].join('\n\n');
}

/** A note's text, from what a suite said it holds. */
const textOf = (note: readonly string[] | string): string =>
	typeof note === 'string' ? note : noteText(note);

/**
 * The links and embeds of a note as the metadata cache reports them,
 * positions and all, read off its text.
 * @param content - The note's text
 */
function referencesOf(content: string): {
	links: unknown[];
	embeds: unknown[];
	frontmatterLinks: unknown[];
} {
	const found: {
		links: unknown[];
		embeds: unknown[];
		frontmatterLinks: unknown[];
	} = { links: [], embeds: [], frontmatterLinks: [] };
	// A link in the properties block is a property's value, which the cache
	// reports apart from the body's, with no position.
	const frontmatterEnd = content.startsWith('---\n')
		? content.indexOf('\n---', 4)
		: -1;
	let offset = 0;
	content.split('\n').forEach((line, index) => {
		for (const match of line.matchAll(
			/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
		)) {
			const start = offset + match.index;
			if (start < frontmatterEnd) {
				found.frontmatterLinks.push({ link: match[2], key: 'audio' });
				continue;
			}
			(match[1] ? found.embeds : found.links).push({
				link: match[2],
				original: match[0],
				position: {
					start: { line: index, col: match.index, offset: start },
					end: {
						line: index,
						col: match.index + match[0].length,
						offset: start + match[0].length,
					},
				},
			});
		}
		offset += line.length + 1;
	});
	return found;
}

/**
 * Builds the vault.
 * @param options - Its recordings, notes, active file and settings
 * @returns The vault and services over it
 */
export function recordingVault(
	options: RecordingVaultOptions = {},
): RecordingVault {
	const app = new App();
	const mock = asMockApp(app);
	const notes = options.notes ?? {};
	mock.vault.seed([
		...(options.recordings ?? []).map((path) => ({
			path,
			data: new ArrayBuffer(8),
		})),
		...Object.entries(notes).map(([path, note]) => ({
			path,
			content: textOf(note),
		})),
	]);
	const file = (path: string): TFile => {
		const found = app.vault.getFileByPath(path);
		if (!found) {
			throw new Error(`No file at ${path} was seeded`);
		}
		return found;
	};
	// Read off the note as it was seeded: like Obsidian's own cache until it
	// parses a changed note again, it does not follow a write.
	const texts = new Map(
		Object.entries(notes).map(([path, note]) => [path, textOf(note)]),
	);
	mock.metadataCache.getFileCache.mockImplementation(
		(note: { path: string }) => {
			const text = texts.get(note.path);
			return text === undefined ? null : referencesOf(text);
		},
	);
	mock.metadataCache.getFirstLinkpathDest.mockImplementation(
		(link: string) => {
			const linkpath = link.split('#')[0] ?? link;
			return (
				app.vault
					.getFiles()
					.find(
						(candidate) =>
							candidate.path === linkpath ||
							candidate.name === linkpath ||
							candidate.basename === linkpath,
					) ?? null
			);
		},
	);
	if (options.active) {
		mock.workspace.seedActiveFile(file(options.active));
	}
	const settings = mergeSettings({
		transcriptionEnabled: true,
		...options.settings,
	});
	const services = {
		...commonActionServices(),
		app,
		getSettings: () => settings,
	};
	return {
		app,
		settings,
		file,
		services,
		fileContext: (recording, note) => ({
			file: file(recording),
			services,
			origin:
				note === undefined
					? RecordingOrigin.direct()
					: RecordingOrigin.inNote(file(note)),
		}),
	};
}
