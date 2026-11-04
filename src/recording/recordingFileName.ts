/**
 * Renders a recording's file names from the template in the settings.
 *
 * The notation is the one Obsidian's core Templates and Daily Notes plugins
 * use: `{{name}}`, and `{{date:FORMAT}}` or `{{time:FORMAT}}` with a Moment
 * format after the colon. Nothing in the text of a template is executed, so a
 * template shared from someone else's vault cannot run code.
 * @module recording/recordingFileName
 */

import { moment } from 'obsidian';
import type { RecordingSessionConfig } from '../types';
import {
	foldSeparators,
	sanitizeFileNameSegment,
	toFileNameSegment,
	truncateToBytes,
	utf8ByteLength,
} from '../utils/fileNames';

/**
 * Obsidian's `moment`, typed as the namespace import of the moment package,
 * which `esModuleInterop` makes non-callable. At runtime it is the function.
 */
const momentOf = moment as unknown as (epochMs: number) => {
	format(pattern: string): string;
};

/**
 * `{{name}}` or `{{name:format}}`. The name is any text up to the colon or the
 * closing braces, so a near miss such as `{{Date}}` or `{{note_name}}` reaches
 * the lookup and is refused instead of passing for plain text.
 */
const VARIABLE = /\{\{\s*([^{}:\s]+)\s*(?::([^{}]*))?\}\}/g;

/**
 * Most bytes a base name may take. A file system that counts bytes allows 255
 * per name, and the plugin appends to the base name afterwards: a segment ending
 * such as `-part12345.webm.tmp`, a `_999` counter, `-recovered.webm`. The rest
 * is left free for those, so a long note name cannot make a temporary file
 * unwritable.
 */
const MAX_BASE_NAME_BYTES = 220;

/** Format of `{{date}}` without one: sorts by name, legal in a file name. */
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

/** Format of `{{time}}` without one: a colon would not survive in a name. */
const DEFAULT_TIME_FORMAT = 'HH-mm-ss';

/** What differs between the files of one session. */
export interface FileNameValues {
	/** Device name of a track, or the merged file's source name. */
	readonly source: string;
	/** Track number, left out for a file that is not one track's. */
	readonly track?: number;
}

/** What a variable is filled from. */
interface Fill {
	readonly session: Pick<RecordingSessionConfig, 'sessionId' | 'fileName'>;
	readonly values: FileNameValues;
	readonly started: { format(pattern: string): string };
	/** The note name as it goes into the name: cleaned, and cut when too long. */
	readonly noteName: string;
}

/** The variables a template may use, each with the text it becomes. */
const VARIABLES = new Map<string, (fill: Fill, format: string) => string>([
	['prefix', ({ session }) => session.fileName.prefix],
	['notename', ({ noteName }) => noteName],
	['source', ({ values }) => values.source],
	[
		'track',
		({ values }) =>
			values.track === undefined ? '' : String(values.track),
	],
	['timestamp', ({ session }) => session.sessionId],
	[
		'date',
		({ started }, format) => started.format(format || DEFAULT_DATE_FORMAT),
	],
	[
		'time',
		({ started }, format) => started.format(format || DEFAULT_TIME_FORMAT),
	],
]);

/**
 * Names the first `{{variable}}` of a template that is not one of the
 * variables, so the settings row can refuse it with a sentence.
 * @param template - The template as typed
 * @returns A message naming the unknown variable and the known ones, or
 * undefined when every variable is known
 */
export function templateProblem(template: string): string | undefined {
	for (const match of template.matchAll(VARIABLE)) {
		const name = match[1] ?? '';
		if (!VARIABLES.has(name)) {
			return `Unknown variable {{${name}}}. Known: ${[...VARIABLES.keys()].join(', ')}.`;
		}
	}
	return undefined;
}

/**
 * Fills the template from the variables and cleans the result for a vault path.
 * @param fill - What the variables are filled from
 * @returns The base name, the session's timestamp when nothing is left
 */
function fillTemplate(fill: Fill): string {
	const text = fill.session.fileName.template.replace(
		VARIABLE,
		(whole: string, name: string, format: string | undefined) =>
			VARIABLES.get(name)?.(fill, format?.trim() ?? '') ?? whole,
	);
	return foldSeparators(
		sanitizeFileNameSegment(text),
		fill.session.sessionId,
	);
}

/**
 * Renders one file's base name, without extension.
 *
 * A variable that is empty disappears and the dashes around it fold into one,
 * so a recording started outside a note is `recording-<timestamp>` and not
 * `recording--<timestamp>`. A `{{name}}` that is not a variable stays as
 * typed: the settings row refuses it, so only a hand-edited data.json reaches
 * here with one, and a name showing it is a clearer sign than a dropped part.
 *
 * Only the note name is free text, so only it has its dots folded in, and only
 * it is cut when the whole name would pass the byte budget. The prefix and the
 * rest of the template are the user's own and keep what they typed.
 * @param session - The session, which holds the template and its values
 * @param values - What differs between this file and the session's others
 * @returns A base name safe to put in a vault path
 */
export function renderRecordingFileName(
	session: Pick<RecordingSessionConfig, 'sessionId' | 'fileName'>,
	values: FileNameValues,
): string {
	const started = momentOf(session.fileName.startedAt);
	const noteName = toFileNameSegment(session.fileName.noteName, '');
	const name = fillTemplate({ session, values, started, noteName });
	const excess = utf8ByteLength(name) - MAX_BASE_NAME_BYTES;
	if (excess <= 0 || noteName === '') {
		return name;
	}
	const uses = [...session.fileName.template.matchAll(VARIABLE)].filter(
		(match) => match[1] === 'notename',
	).length;
	if (uses === 0) {
		return name;
	}
	// The note name is the only part that can shrink, and it appears once per
	// use, so each use gives up its share of the excess.
	const room = Math.max(
		0,
		utf8ByteLength(noteName) - Math.ceil(excess / uses),
	);
	return fillTemplate({
		session,
		values,
		started,
		noteName: foldSeparators(truncateToBytes(noteName, room), ''),
	});
}
