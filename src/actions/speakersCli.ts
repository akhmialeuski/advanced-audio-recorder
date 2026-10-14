/**
 * Renaming the speakers of a recording from the command line.
 *
 * Without names the command lists the roster, label and name, so a script can
 * see what there is to rename. With `map=` it applies the names exactly as the
 * rename dialog would: the same validation, the same rewrite of every
 * recorded output, the same commit of the roster and its history. The one
 * thing the dialog asks about - a merge, which cannot be undone - is answered
 * on the command line by the `merge` flag, and refused without it.
 * @module actions/speakersCli
 */

import type { CliData, CliFlags } from 'obsidian';
import {
	effectiveProfileId,
	ProfileKindId,
	profileIdNamed,
	profilesOfKind,
} from '../settings/profiles';
import {
	applySpeakerNames,
	describeMerges,
	readSpeakerSection,
	undoSpeakerRename,
	type SpeakerRenameDeps,
} from '../speakers/speakerRenameFlow';
import type { SpeakerMerge } from '../speakers/speakerRename';
import type { TranscriptSection } from '../sidecar/recordingSidecarModel';
import { collectingNotify } from '../utils/notify';
import { cliFlag, cliText, flagParam, valueParam } from '../obsidian/cliArgs';
import type { FileContext } from './PluginAction';

/** Names the speakers: `label=name`, one pair per speaker, `;` between. */
export const MAP_PARAM = 'map';
/** Confirms a merge of two speakers into one name. */
export const MERGE_FLAG = 'merge';
/** Allows rewriting notes that carry no timecode link to scope by. */
export const BROAD_FLAG = 'broad';
/** Reverts the last rename instead of applying one. */
export const UNDO_FLAG = 'undo';
/** Participant profile the applied names are added to. */
export const PROFILE_PARAM = 'profile';

/** The parameters of the speakers command, beyond its target. */
export const SPEAKER_PARAMS: CliFlags = {
	[MAP_PARAM]: valueParam(
		'"<label>=<name>; ..."',
		'Names to give the speakers. Without it the speakers are listed.',
	),
	[MERGE_FLAG]: flagParam(
		'Confirm giving two speakers one name, which cannot be undone.',
	),
	[BROAD_FLAG]: flagParam(
		'Also rewrite notes that carry no timecode link to this recording.',
	),
	[UNDO_FLAG]: flagParam('Revert the last rename instead.'),
	[PROFILE_PARAM]: valueParam(
		'<profile>',
		'Participant profile the names are added to, or none.',
	),
};

/** Separates the pairs of `map=`; a newline does too. */
const PAIR_SEPARATOR = /[;\n]/;

/**
 * Lists the roster the way the dialog shows it: one speaker per line.
 * @param section - The stored roster
 */
function listSpeakers(section: TranscriptSection): string {
	const rows = section.speakers.map(
		(entry) => `${entry.label}: ${entry.name ? entry.name : '(no name)'}`,
	);
	return [
		...rows,
		`Rename with ${MAP_PARAM}="<label>=<name>; <label>=<name>".`,
	].join('\n');
}

/**
 * Reads `map=` into one name per label, checking every label against the
 * roster.
 * @param section - The stored roster
 * @param map - What was typed
 * @returns The names by label, or the refusal
 */
export function parseSpeakerMap(
	section: TranscriptSection,
	map: string,
): Map<string, string> | string {
	const labels = new Set(section.speakers.map((entry) => entry.label));
	const names = new Map<string, string>();
	for (const pair of map.split(PAIR_SEPARATOR)) {
		if (pair.trim() === '') {
			continue;
		}
		const separator = pair.indexOf('=');
		if (separator < 0) {
			return `"${pair.trim()}" is not <label>=<name>.`;
		}
		const label = pair.slice(0, separator).trim();
		if (!labels.has(label)) {
			return `No speaker labelled "${label}". The labels are: ${[...labels].join(', ')}.`;
		}
		if (names.has(label)) {
			return `"${label}" is named twice.`;
		}
		names.set(label, pair.slice(separator + 1).trim());
	}
	return names.size === 0
		? `${MAP_PARAM}= names no speaker. Use ${MAP_PARAM}="<label>=<name>".`
		: names;
}

/**
 * The participant profile the names go to: the one typed, or the one the
 * recording was transcribed with, which is what the dialog preselects.
 * @param context - The recording
 * @param section - Its roster
 * @param args - The arguments as typed
 * @returns The profile id ('' for none), or the refusal
 */
function namesProfile(
	context: FileContext,
	section: TranscriptSection,
	args: CliData,
): { id: string } | { refusal: string } {
	const profiles = context.services.getSettings().profiles;
	const typed = cliText(args, PROFILE_PARAM);
	return typed === null
		? {
				id: effectiveProfileId(
					profilesOfKind(profiles, ProfileKindId.Participants),
					section.participantProfileId ?? '',
				),
			}
		: profileIdNamed(profiles, ProfileKindId.Participants, typed);
}

/**
 * Lists, renames, or reverts the speakers of a recording.
 * @param context - The recording
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function speakersFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const section = await readSpeakerSection(
		services.recordingSidecar,
		file.path,
	);
	if (section === 'unreadable') {
		return `The sidecar of ${file.path} could not be read, so its speakers are unreachable. Restore or remove the .markers.json file next to the recording, then try again.`;
	}
	if (section === 'empty') {
		return `No speakers are stored for ${file.path}. Transcribe it with speaker diarization first.`;
	}
	const notes = collectingNotify();
	const deps: SpeakerRenameDeps = {
		app: services.app,
		file,
		sidecar: services.recordingSidecar,
		getSettings: services.getSettings,
		saveSettings: services.saveSettings,
		notify: notes.notify,
	};
	const allowBroad = cliFlag(args, BROAD_FLAG);
	const withNotes = (answer: string): string =>
		[answer, ...notes.messages].join('\n');
	if (cliFlag(args, UNDO_FLAG)) {
		// Only what a rename recorded can be undone, as the dialog offers
		// Undo only then: names that came with the transcript are no rename,
		// and stepping back from them would strip them to the engine labels.
		if (section.history.length === 0) {
			return `No rename of the speakers of ${file.path} to undo.`;
		}
		return withNotes(await undoSpeakerRename(deps, section, allowBroad));
	}
	const map = cliText(args, MAP_PARAM);
	if (map === null) {
		return listSpeakers(section);
	}
	const names = parseSpeakerMap(section, map);
	if (typeof names === 'string') {
		return names;
	}
	const profile = namesProfile(context, section, args);
	if ('refusal' in profile) {
		return profile.refusal;
	}
	let unconfirmed: readonly SpeakerMerge[] = [];
	const outcome = await applySpeakerNames(deps, section, {
		// Every speaker keeps the name it has unless the map names it, as the
		// dialog's rows start out filled with the stored names.
		entries: section.speakers.map((entry) => ({
			label: entry.label,
			name: names.get(entry.label) ?? entry.name ?? '',
		})),
		allowBroad,
		profileId: profile.id,
		confirmMerges: (merges) => {
			unconfirmed = merges;
			return Promise.resolve(cliFlag(args, MERGE_FLAG));
		},
		broadOptInHint: `add ${BROAD_FLAG} to rewrite them as well.`,
	});
	if (outcome.kind === 'declined') {
		return `${describeMerges(unconfirmed)}. Merged speakers cannot be told apart again; add ${MERGE_FLAG} to do it anyway.`;
	}
	return withNotes(outcome.message);
}
