/**
 * Actions on a point in a recording: marking it as a bookmark or a chapter,
 * and copying a link to it. The player's menu offers them at the point that
 * was right-clicked, the palette at the position of the playback that is
 * running, and the command line at the time it names - one definition, three
 * ways of saying "where".
 * @module actions/position/positionActions
 */

import { MarkdownView, Notice } from 'obsidian';
import type { CliData, CliFlags } from 'obsidian';
import { COMMAND_IDS, PLAYER_ICONS } from '../../constants';
import { MARKER_KIND, type MarkerKind } from '../../markers/markerModel';
import { addRecordingMarker } from '../../markers/addRecordingMarker';
import {
	copyTimecodeLink,
	timecodeLinkBuilder,
} from '../../obsidian/timecodeRefs';
import { formatTimecode } from '../../utils/TimeUtils';
import { isAudioFile } from '../../utils/audioFile';
import { cliText, cliTime, valueParam } from '../../obsidian/cliArgs';
import type { PlaybackControlsState } from '../../player/playbackControls';
import type {
	ActionFamily,
	ActionServices,
	PositionAction,
	PositionContext,
} from '../core/PluginAction';
import {
	FILE_PARAM,
	PATH_PARAM,
	NOTE_PARAM,
	RECORDING_PARAM,
	SINGLE_RECORDING_PARAMS,
	namedRecordings,
} from '../file/recordingTargets';
import { isRefusal, type Refusable } from '../../utils/refusal';

/** Where in the recording, on the command line. */
export const AT_PARAM = 'at';

/** The marker label, on the command line. */
export const LABEL_PARAM = 'label';

/**
 * The label parameter of every command that adds a marker, at a point of a
 * recording here or at the live position of a session.
 */
export const MARKER_LABEL_PARAMS: CliFlags = {
	[LABEL_PARAM]: valueParam(
		'<text>',
		'Label of the marker. Numbered by default.',
	),
};

/**
 * Adds a marker at the position and refreshes every open player of the
 * recording.
 * @param context - The position
 * @param kind - Bookmark or chapter
 * @param label - The label, or null for the default one
 * @returns The sentence the player says for a marker it adds itself
 */
async function addMarkerHere(
	context: PositionContext,
	kind: MarkerKind,
	label: string | null,
): Promise<string> {
	const { file, services, seconds } = context;
	const marker = await addRecordingMarker(
		services.recordingSidecar,
		file.path,
		seconds,
		kind,
		label,
	);
	services.onMarkersChanged(file.path);
	return `${marker.label} added at ${formatTimecode(marker.time)}`;
}

/**
 * The link to the position, built the way a transcript's timecodes are, so
 * the player follows it.
 * @param context - The position
 */
function timestampLink(context: PositionContext): string {
	const seconds = Math.floor(Math.max(0, context.seconds));
	return timecodeLinkBuilder(
		context.services.app,
		context.file,
		context.note?.path ?? '',
	)(seconds, formatTimecode(seconds));
}

/**
 * Copies the link to the clipboard and says so.
 * @param context - The position
 */
function copyTimestampLink(context: PositionContext): Promise<void> {
	return copyTimecodeLink(
		context.services.app,
		context.file,
		context.note?.path ?? '',
		context.seconds,
	);
}

/** Whether a marker can be added at the position. */
const whereMarkersGo = ({ services, editable }: PositionContext): boolean =>
	editable && services.getSettings().playerEnableMarkers;

/** What the command line says where no marker can be added. */
const markersOff = (): string =>
	'Markers are switched off in settings, or the player is read-only.';

/**
 * One of the two marker actions, which differ only in the kind they add.
 * @param kind - Bookmark or chapter
 * @param texts - The command id, titles, icon and command name
 */
function markerAction(
	kind: MarkerKind,
	texts: {
		commandId: string;
		title: string;
		menuTitle: string;
		icon: string;
		name: string;
		description: string;
	},
): PositionAction {
	return {
		commandId: texts.commandId,
		title: texts.title,
		menuTitle: texts.menuTitle,
		icon: texts.icon,
		isAvailable: whereMarkersGo,
		run: async (context: PositionContext): Promise<void> => {
			// The notice is earned by the write: announcing an add the sidecar
			// refused would report a marker that does not exist.
			new Notice(await addMarkerHere(context, kind, null));
		},
		cli: {
			name: texts.name,
			description: texts.description,
			params: MARKER_LABEL_PARAMS,
			unavailable: markersOff,
			execute: (context: PositionContext, args: CliData) =>
				addMarkerHere(context, kind, cliText(args, LABEL_PARAM)),
		},
	};
}

/** Every action on a position, in menu order. */
export const POSITION_ACTIONS: readonly PositionAction[] = [
	markerAction(MARKER_KIND.bookmark, {
		commandId: COMMAND_IDS.addPlaybackBookmark,
		title: 'Add bookmark at current playback position',
		menuTitle: 'Add marker here',
		icon: PLAYER_ICONS.addBookmark,
		name: 'add-bookmark',
		description: 'Add a bookmark to a recording at a time.',
	}),
	markerAction(MARKER_KIND.chapter, {
		commandId: COMMAND_IDS.addPlaybackChapter,
		title: 'Add chapter at current playback position',
		menuTitle: 'Add chapter here',
		icon: PLAYER_ICONS.addChapter,
		name: 'add-chapter',
		description: 'Add a chapter to a recording at a time.',
	}),
	{
		commandId: COMMAND_IDS.copyTimestampLink,
		title: 'Copy timestamp link at current playback position',
		menuTitle: 'Copy timestamp link here',
		icon: 'link',
		isAvailable: (): boolean => true,
		run: copyTimestampLink,
		cli: {
			name: 'timestamp-link',
			description:
				'Print a link to a time in a recording, the kind a transcript carries.',
			execute: timestampLink,
		},
	},
];

/**
 * The position of the playback that is running, with the note links to it
 * are written for: the active note, when one is active.
 * @param services - Injected services
 * @param state - The playback, or null when nothing plays
 */
function playbackPosition(
	services: ActionServices,
	state: PlaybackControlsState | null,
): PositionContext | null {
	if (!state) {
		return null;
	}
	const file = services.app.vault.getFileByPath(state.recordingPath);
	if (!file || !isAudioFile(file)) {
		return null;
	}
	const note =
		services.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	return {
		file,
		seconds: state.currentTime,
		// The playing player's own gate, which already reads the setting and
		// whether that player is read-only.
		editable: state.markersEnabled,
		...(note ? { note } : {}),
		services,
	};
}

/**
 * The position the command line names: a recording and `at=`, or, with no
 * recording named, the playback that is running, `at=` moving off it.
 * @param services - Injected services
 * @param playback - The playback that is running
 * @param args - The arguments as typed
 */
function namedPosition(
	services: ActionServices,
	playback: () => PlaybackControlsState | null,
	args: CliData,
): Refusable<PositionContext[]> {
	const at = cliTime(args, AT_PARAM);
	if (isRefusal(at)) {
		return at;
	}
	// Any parameter naming a recording or its note names the target; only
	// with none of them is the recording playing in Obsidian the one meant.
	const named = [FILE_PARAM, PATH_PARAM, RECORDING_PARAM, NOTE_PARAM].some(
		(param) => cliText(args, param) !== null,
	);
	if (!named) {
		const playing = playbackPosition(services, playback());
		if (playing) {
			return {
				value: [
					at.value === null
						? playing
						: { ...playing, seconds: at.value },
				],
			};
		}
	}
	if (at.value === null) {
		return {
			refusal: `Name the time with ${AT_PARAM}=<seconds|m:ss|h:mm:ss>, or play the recording in Obsidian.`,
		};
	}
	// A time belongs to one recording, so a note of several is answered
	// with the names to pick from, never with the advice to run on each.
	const recordings = namedRecordings(services, args, { several: false });
	if (isRefusal(recordings)) {
		return recordings;
	}
	const only =
		recordings.value.length === 1 ? recordings.value[0] : undefined;
	if (!only) {
		return {
			refusal: `A time belongs to one recording; name it with ${RECORDING_PARAM}=<name>.`,
		};
	}
	return {
		value: [
			{
				file: only.file,
				seconds: at.value,
				editable: true,
				...(only.note ? { note: only.note } : {}),
				services,
			},
		],
	};
}

/**
 * The position actions as a family: the palette acts at the playback that is
 * running, the command line at the time it names.
 * @param services - Injected services every action shares
 * @param playback - Reads the playback that is running, or null
 * @returns The family
 */
export function positionActionFamily(
	services: ActionServices,
	playback: () => PlaybackControlsState | null,
): ActionFamily<PositionContext> {
	return {
		actions: POSITION_ACTIONS,
		activeTargets: () => {
			const playing = playbackPosition(services, playback());
			return playing ? [playing] : [];
		},
		cliTarget: {
			params: {
				...SINGLE_RECORDING_PARAMS,
				[AT_PARAM]: valueParam(
					'<seconds|m:ss|h:mm:ss>',
					'Time in the recording. Defaults to where the playback is.',
				),
			},
			resolve: (args) => namedPosition(services, playback, args),
		},
		describe: (context) =>
			`${context.file.path} at ${formatTimecode(context.seconds)}`,
	};
}
