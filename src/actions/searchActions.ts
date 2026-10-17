/**
 * Actions that search the vault rather than act on a file or on playback.
 * They belong to no particular recording, which is why they are their own
 * list: the recording resolver finds nothing in a note without recordings,
 * and a vault-wide search must be offered from any note at all.
 *
 * On the command line the search answers with what it found instead of
 * opening a picker, and the queue answers with what it holds, taking the
 * queue dialog's buttons as flags.
 * @module actions/searchActions
 */

import { prepareSimpleSearch } from 'obsidian';
import type { CliData } from 'obsidian';
import { COMMAND_IDS, PLAYER_ICONS } from '../constants';
import { ICON_MIC } from '../ui/RibbonIcon';
import { MARKER_KIND } from '../markers/markerModel';
import type { MarkerHit } from '../markers/MarkerSearchIndex';
import { formatTimecode } from '../utils/TimeUtils';
import {
	choiceParam,
	cliChoice,
	cliFlag,
	cliNumber,
	cliText,
	flagParam,
	isRefusal,
	valueParam,
} from '../obsidian/cliArgs';
import type {
	ActionFamily,
	QueueStatusView,
	SearchAction,
	SearchServices,
} from './PluginAction';

/** Needs nothing beyond the plugin being loaded. */
const always = (): boolean => true;

/**
 * The text a marker is found by: the same fields the search dialog matches,
 * its label, its recording, and its note.
 * @param hit - The marker
 */
const searchText = (hit: MarkerHit): string =>
	[hit.label, hit.recordingName, hit.note].join(' ');

/**
 * One marker per line: a link target to its time, the time, the kind, and
 * the label, so a script can open the place a line names.
 * @param hit - The marker
 */
const hitLine = (hit: MarkerHit): string =>
	`${hit.recordingPath}#t=${String(Math.floor(hit.time))}\t${formatTimecode(hit.time)}\t${hit.kind}\t${hit.label}${hit.note ? `\t${hit.note}` : ''}`;

/**
 * Finds markers across the vault.
 * @param services - Search services
 * @param args - The arguments as typed
 * @returns The answer
 */
async function searchMarkers(
	services: SearchServices,
	args: CliData,
): Promise<string> {
	const kind = cliChoice(args, 'kind', Object.values(MARKER_KIND));
	if (isRefusal(kind)) {
		return kind.refusal;
	}
	const limit = cliNumber(args, 'limit', {
		min: 1,
		max: Number.MAX_SAFE_INTEGER,
		integer: true,
	});
	if (isRefusal(limit)) {
		return limit.refusal;
	}
	const format = cliChoice(args, 'format', ['text', 'json'] as const);
	if (isRefusal(format)) {
		return format.refusal;
	}
	const query = cliText(args, 'query');
	// Obsidian's own matcher: every word of the query, in any order and case,
	// the way the vault search reads a query.
	const matches = query === null ? null : prepareSimpleSearch(query);
	const hits = (await services.markerHits())
		.filter((hit) => kind.value === null || hit.kind === kind.value)
		.filter((hit) => matches === null || matches(searchText(hit)) !== null)
		.slice(0, limit.value ?? undefined);
	if (format.value === 'json') {
		return JSON.stringify(hits, null, 2);
	}
	return hits.length === 0
		? 'No markers match.'
		: hits.map(hitLine).join('\n');
}

/**
 * The queue in a few lines: a summary, then one line per recording.
 * @param status - What the queue holds
 */
export function describeQueue(status: QueueStatusView): string {
	if (status.entries.length === 0) {
		return 'The transcription queue is empty.';
	}
	const waiting = status.entries.filter(
		(entry) => entry.state === 'waiting',
	).length;
	const state = status.running
		? 'running'
		: status.paused
			? 'paused'
			: 'not running';
	return [
		`The transcription queue is ${state}; ${String(waiting)} of ${String(status.entries.length)} waiting.`,
		...status.entries.map(
			(entry) =>
				`${entry.state}\t${entry.path}${entry.error ? `\t${entry.error}` : ''}`,
		),
	].join('\n');
}

/**
 * Drives the queue the way its dialog's buttons do, then reports it.
 * @param services - Search services
 * @param args - The arguments as typed
 * @returns The answer
 */
async function driveQueue(
	services: SearchServices,
	args: CliData,
): Promise<string> {
	const queue = services.transcriptionQueue;
	const said: string[] = [];
	// Read first: the queue is loaded from storage on its first read, and an
	// edit before that would be made to an empty queue.
	await queue.status();
	const remove = cliText(args, 'remove');
	if (remove !== null) {
		said.push(
			queue.remove(remove)
				? `Removed ${remove}.`
				: `${remove} is not in the queue, or is being transcribed now.`,
		);
	}
	if (cliFlag(args, 'clear')) {
		queue.clear();
		said.push('Cleared everything that was not running.');
	}
	if (cliFlag(args, 'pause')) {
		queue.pause();
		said.push('Paused after the recording being transcribed.');
	}
	if (cliFlag(args, 'start')) {
		queue.start();
		said.push('Started.');
	}
	return [...said, describeQueue(await queue.status())].join('\n');
}

/** Every vault-wide action that is bound to no file, in palette order. */
export const SEARCH_ACTIONS: readonly SearchAction[] = [
	{
		commandId: COMMAND_IDS.searchMarkers,
		title: 'Search markers and chapters',
		icon: PLAYER_ICONS.searchMarkers,
		isAvailable: always,
		run: (services): Promise<void> => services.openMarkerSearch(),
		cli: {
			name: 'markers',
			description:
				'List the markers and chapters of every recording, or the ones matching a query.',
			params: {
				query: valueParam(
					'<text>',
					'Words the label, the recording or the note must contain.',
				),
				kind: choiceParam(
					Object.values(MARKER_KIND),
					'Only bookmarks, or only chapters.',
				),
				limit: valueParam('<n>', 'Show at most this many.'),
				format: choiceParam(
					['text', 'json'],
					'Answer as lines or JSON.',
				),
			},
			opensDialog: true,
			execute: searchMarkers,
		},
	},
	{
		commandId: COMMAND_IDS.openTranscriptionQueue,
		title: 'Show the transcription queue',
		icon: 'list-ordered',
		isAvailable: always,
		run: (services): void => {
			services.transcriptionQueue.open();
		},
		cli: {
			name: 'queue',
			description:
				'Show the transcription queue, and start, pause, clear or edit it.',
			params: {
				start: flagParam('Start, or resume, transcribing what waits.'),
				pause: flagParam(
					'Pause after the recording being transcribed.',
				),
				clear: flagParam('Remove every entry that is not running.'),
				remove: valueParam('<vault path>', 'Remove one recording.'),
			},
			opensDialog: true,
			execute: driveQueue,
		},
	},
	{
		commandId: COMMAND_IDS.openRecordingPanel,
		title: 'Open the recording panel',
		// The microphone the panel's sidebar tab and the ribbon carry.
		icon: ICON_MIC,
		isAvailable: always,
		run: (services): Promise<void> => services.openRecordingPanel(),
		cli: {
			name: 'panel',
			description: 'Open the recording panel in the Obsidian sidebar.',
			// The panel is a view of the app with nothing to print instead, so
			// the command line opens it as the palette does.
			execute: async (services): Promise<string> => {
				await services.openRecordingPanel();
				return 'Opened the recording panel in Obsidian.';
			},
		},
	},
];

/**
 * The search actions as a family: bound to nothing, so always offered.
 * @param services - Search services
 * @returns The family
 */
export function searchActionFamily(
	services: SearchServices,
): ActionFamily<SearchServices> {
	return {
		actions: SEARCH_ACTIONS,
		activeTargets: () => [services],
		cliTarget: { params: {}, resolve: () => ({ value: [services] }) },
		describe: () => 'the vault',
	};
}
