/**
 * Collects the facts of a run and fills them into the prompts it sends.
 *
 * Every fact a prompt can name is already at hand when the run calls a model:
 * the note the result goes to and its properties, the recording, its length,
 * the transcript's language and speakers, and the run's participant and
 * dictionary profiles. This is where they are read, once per prompt, and handed
 * to the shared template engine with the catalogue the settings check the same
 * prompt against.
 * @module transcription/runFacts
 */

import type { RoutedNote } from '../templates/templateRouting';
import { type App, type CachedMetadata, Notice, type TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import {
	resolveDictionaryTermList,
	resolveRunParticipants,
} from '../settings/profileResolution';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	PROPERTIES_ROOT,
	RUN_VARIABLES,
	type RunFacts,
	runTemplateContext,
} from '../templates/runVariables';
import { sharedTemplateEngine } from '../templates/TemplateEngine';
import type { FieldReads } from '../templates/templatePaths';
import type { Transcript } from './TranscriptTypes';

/** Everything the facts of one run are read from. */
export interface RunFactsSource {
	readonly app: App;
	readonly settings: AudioRecorderSettings;
	/** The recording the run is about. */
	readonly recording: TFile;
	/** Vault path of the note the result goes to; '' or absent for none. */
	readonly notePath?: string | undefined;
	/** The transcript, when the run has one in memory. */
	readonly transcript?: Transcript | undefined;
	/**
	 * The recording's length when the transcript does not carry it, as a run
	 * that read its lines from a note knows it.
	 */
	readonly durationSeconds?: number | null | undefined;
	/** The transcript's language when the transcript does not carry it. */
	readonly language?: string | undefined;
}

/** Fills the facts of a run into one prompt. */
export type PromptExpander = (text: string) => string;

/** A prompt left as it was typed, for a caller that has no run to describe. */
export const VERBATIM: PromptExpander = (text) => text;

/**
 * The tags of a note, from its frontmatter and its body, without the '#'.
 * @param cache - The note's cached metadata
 */
function tagsOf(cache: CachedMetadata | null): string[] {
	const listed: unknown = cache?.frontmatter?.['tags'];
	const fromProperties = (Array.isArray(listed) ? listed : [listed])
		.filter((tag): tag is string => typeof tag === 'string')
		.flatMap((tag) => tag.split(/[,\s]+/));
	const fromBody = (cache?.tags ?? []).map((tag) => tag.tag);
	const tags = [...fromProperties, ...fromBody]
		.map((tag) => tag.replace(/^#/, ''))
		.filter((tag) => tag !== '');
	return [...new Set(tags)];
}

/**
 * What a note says of itself for picking its template: its path, properties
 * and tags.
 * @param app - The app, for the vault and the metadata cache
 * @param notePath - Vault path of the note; '' for none
 * @returns Null when there is no such note
 */
export function routedNoteOf(app: App, notePath: string): RoutedNote | null {
	const note = notePath === '' ? null : app.vault.getFileByPath(notePath);
	if (!note) {
		return null;
	}
	const cache = app.metadataCache.getFileCache(note);
	return {
		path: note.path,
		frontmatter: cache?.frontmatter,
		tags: tagsOf(cache),
	};
}

/**
 * The properties of a note a template reads, and no others.
 * @param cache - The note's cached metadata
 * @param reads - The fields the template names
 */
function propertiesOf(
	cache: CachedMetadata | null,
	reads: FieldReads,
): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = { ...cache?.frontmatter };
	delete frontmatter['position'];
	if (reads === 'all') {
		return frontmatter;
	}
	return Object.fromEntries(
		[...reads]
			.filter((name) => Object.hasOwn(frontmatter, name))
			.map((name) => [name, frontmatter[name]]),
	);
}

/** What the note the result goes to says about the run. */
interface NoteFacts {
	readonly note: TFile | null;
	readonly tags: readonly string[];
	readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * The facts read from the note the result goes to.
 * @param app - The app, for the vault and the metadata cache
 * @param notePath - Vault path of the note; '' for none
 * @param reads - Which properties to read
 */
function noteFacts(app: App, notePath: string, reads: FieldReads): NoteFacts {
	const note = notePath === '' ? null : app.vault.getFileByPath(notePath);
	const cache = note ? app.metadataCache.getFileCache(note) : null;
	return {
		note,
		tags: tagsOf(cache),
		properties: propertiesOf(cache, reads),
	};
}

/**
 * The length and language of the recording: the transcript's own when the run
 * has one, otherwise what the caller knew.
 * @param source - Where the facts are read from
 */
function timingFacts(
	source: RunFactsSource,
): Pick<RunFacts, 'durationSeconds' | 'language' | 'speakers'> {
	const transcript = source.transcript;
	const language = transcript?.language ?? source.language ?? '';
	if (!transcript) {
		return {
			durationSeconds: source.durationSeconds ?? null,
			language,
			speakers: [],
		};
	}
	return {
		durationSeconds: transcript.segments.at(-1)?.end ?? null,
		language,
		speakers: transcript.speakers,
	};
}

/**
 * The facts of one run.
 * @param source - Where the facts are read from
 * @param reads - Which properties of the note to read
 * @returns The facts, every one present, empty where unknown
 */
export function collectRunFacts(
	source: RunFactsSource,
	reads: FieldReads,
): RunFacts {
	const { app, recording } = source;
	const { note, tags, properties } = noteFacts(
		app,
		source.notePath ?? '',
		reads,
	);
	const notePath = note?.path ?? '';
	return {
		title: note?.basename ?? recording.basename,
		notePath,
		recordingName: recording.name,
		recordingPath: recording.path,
		recordingLink: app.fileManager.generateMarkdownLink(
			recording,
			notePath,
		),
		recordedAt: recording.stat.ctime,
		...timingFacts(source),
		participants: resolveRunParticipants(source.settings),
		dictionary: resolveDictionaryTermList(source.settings),
		tags,
		properties,
	};
}

/**
 * Fills the facts of a run into prompts. The facts are read for each prompt
 * rather than once, because which properties are read depends on what the
 * prompt names.
 *
 * A prompt that cannot be rendered is sent as it was typed, with a notice:
 * the run has already paid for its transcript, and a broken brace in an
 * instruction is no reason to lose the pass that follows.
 * @param source - Where the facts are read from
 * @returns The expander for this run
 */
export function promptExpander(source: RunFactsSource): PromptExpander {
	const engine = sharedTemplateEngine();
	return (text) => {
		if (!text.includes('{{')) {
			return text;
		}
		try {
			const facts = collectRunFacts(
				source,
				engine.fieldsRead(text, PROPERTIES_ROOT),
			);
			return engine.render(
				text,
				runTemplateContext(facts),
				RUN_VARIABLES,
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} A prompt template could not be rendered; sending it as typed.`,
				error,
			);
			new Notice(
				`The prompt template could not be filled in (${errorMessage(error)}); it was sent as typed.`,
			);
			return text;
		}
	};
}
