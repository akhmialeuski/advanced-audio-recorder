/**
 * Renaming the speakers of one recording, from the names typed to the outputs
 * rewritten and the roster committed. The rename dialog is a form over this,
 * and the command line passes the names as a parameter; both apply exactly
 * this sequence, so a rename means the same thing whichever surface made it.
 *
 * The order is the one the outputs depend on: the typed names are validated,
 * the plan is made against the stored roster, the recorded outputs are
 * rewritten, and only then are the roster and its history committed - so the
 * sidecar never asserts names the outputs were not even attempted with.
 * @module speakers/speakerRenameFlow
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { findProfile, ProfileKindId } from '../settings/profiles';
import { appendParticipantsToNote } from '../settings/ProfileNoteStore';
import { ProfileTextSource } from '../settings/ProfileTextSource';
import { addParticipantsToProfile } from '../settings/profileResolution';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type {
	ParticipantUpdate,
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import type { Notify } from '../utils/notify';
import {
	addedMerges,
	labelCollisionNames,
	planHasWork,
	planSpeakerRename,
	speakerMerges,
	type SpeakerMerge,
	type SpeakerNameEntry,
} from './speakerRename';
import {
	applySpeakerRenamesWithSidecar,
	type SpeakerRenameApplyResult,
} from './applySpeakerRenames';

/**
 * The slice of the recording sidecar store a rename needs: read the
 * transcript section, write the roster's names back, and append to the
 * rename history. Structural so tests can stub it.
 */
export interface SpeakerRenameSidecarAccess {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/** Whether the sidecar file exists but could not be read (after a read). */
	isSidecarCorrupt(path: string): boolean;
	/**
	 * Commits an applied rename atomically: roster, history entry, and the
	 * names it added to the recording's participant roster in one write, so
	 * none can ever be persisted without the others.
	 */
	commitRename(
		path: string,
		entries: readonly SpeakerEntry[],
		names: Record<string, string>,
		participants?: ParticipantUpdate,
	): Promise<void>;
	/** Replaces the speaker roster for a recording path (undo). */
	setSpeakers(path: string, entries: readonly SpeakerEntry[]): Promise<void>;
	/** Removes the newest history entry (an undo consumed it). */
	popHistory(path: string): Promise<void>;
}

/** Everything a rename reaches beyond the recording itself. */
export interface SpeakerRenameDeps {
	/** Obsidian App. */
	readonly app: App;
	/** The recording being renamed. */
	readonly file: TFile;
	/** Its sidecar. */
	readonly sidecar: SpeakerRenameSidecarAccess;
	/** Returns current plugin settings. */
	readonly getSettings: () => AudioRecorderSettings;
	/** Persists settings after a profile grew. */
	readonly saveSettings: () => Promise<void>;
	/** Where a side note (a profile that could not grow) is told. */
	readonly notify: Notify;
}

/** Why a recording has no roster to rename. */
export type MissingRoster =
	/** The sidecar exists but could not be read; its names may be intact. */
	| 'unreadable'
	/** No roster is stored: never diarized, or transcribed before rosters. */
	| 'empty';

/**
 * Reads the roster a rename works on.
 * @param sidecar - The sidecar access
 * @param path - The recording path
 * @returns The section with at least one speaker, or why there is none
 */
export async function readSpeakerSection(
	sidecar: SpeakerRenameSidecarAccess,
	path: string,
): Promise<TranscriptSection | MissingRoster> {
	let section: TranscriptSection | null;
	try {
		section = await sidecar.getTranscript(path);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to read the sidecar roster for ${path}:`,
			error,
		);
		section = null;
	}
	// An unreadable sidecar is not an empty one: the stored names may be
	// intact on disk, so it is not reported as needing a new transcription.
	if (sidecar.isSidecarCorrupt(path)) {
		return 'unreadable';
	}
	return section && section.speakers.length > 0 ? section : 'empty';
}

/** What one apply was asked to do. */
export interface SpeakerRenameRequest {
	/** One entry per speaker of the roster: its label and the name typed. */
	readonly entries: readonly SpeakerNameEntry[];
	/** Whether notes without timecode links may be rewritten as a whole. */
	readonly allowBroad: boolean;
	/** Participant profile the names are added to, '' for none. */
	readonly profileId: string;
	/**
	 * Asked before a merge the roster does not carry yet is written. The
	 * dialog asks the user; the command line answers from a flag.
	 */
	readonly confirmMerges: (
		merges: readonly SpeakerMerge[],
	) => Promise<boolean>;
	/** How the outcome names the way to rewrite a note without timecodes. */
	readonly broadOptInHint: string;
}

/** How one apply ended. */
export type SpeakerRenameOutcome =
	| {
			/** Refused before anything was written; the dialog stays open. */
			readonly kind: 'refused';
			readonly message: string;
	  }
	| {
			/** A merge was not confirmed; nothing was written. */
			readonly kind: 'declined';
	  }
	| {
			/** There was nothing to change. */
			readonly kind: 'unchanged';
			readonly message: string;
	  }
	| {
			/** The rename was applied. */
			readonly kind: 'applied';
			readonly message: string;
			/** Every count, for the debug log. */
			readonly counts: string;
	  };

/**
 * Describes each merge an apply would make, in one sentence.
 * @param merges - The merges
 */
export function describeMerges(merges: readonly SpeakerMerge[]): string {
	return merges
		.map((merge) => `${merge.labels.join(', ')} become ${merge.name}`)
		.join('; ');
}

/**
 * Validates the typed names, plans the rename against the stored roster,
 * rewrites the recorded outputs, and commits the roster and its history.
 * The plan's replacements also target the original engine labels, healing
 * outputs an earlier rewrite missed.
 * @param deps - What the rename reaches
 * @param section - The stored roster
 * @param request - The names and options
 * @returns How it ended
 */
export async function applySpeakerNames(
	deps: SpeakerRenameDeps,
	section: TranscriptSection,
	request: SpeakerRenameRequest,
): Promise<SpeakerRenameOutcome> {
	const { entries } = request;
	// Two speakers given the same real name is a merge and goes ahead (behind
	// the confirmation below); a name equal to another speaker's engine LABEL
	// is still refused, because it says nothing about which of the two was
	// meant and leaves the roster unable to answer it either.
	const collisions = labelCollisionNames(entries);
	if (collisions.length > 0) {
		return {
			kind: 'refused',
			message:
				`A name cannot equal another speaker's label ` +
				`(${collisions.join(', ')}): nothing could then tell ` +
				'their lines apart in the outputs. To make them one ' +
				'speaker, give both rows the same real name instead.',
		};
	}
	const merges = addedMerges(
		speakerMerges(
			section.speakers.map((entry) => ({
				label: entry.label,
				name: entry.name ?? '',
			})),
		),
		speakerMerges(entries),
	);
	if (merges.length > 0 && !(await request.confirmMerges(merges))) {
		return { kind: 'declined' };
	}
	const typed = new Map(entries.map((entry) => [entry.label, entry.name]));
	const plan = planSpeakerRename(
		section.speakers,
		(label) => typed.get(label) ?? '',
	);
	// The roster and the outputs are two different questions. A roster that
	// already holds these names still leaves healing rules for an output that
	// shows an engine label (a write that failed, a note the broad opt-in had
	// not been granted for yet), so an apply is refused only when neither has
	// anything left to do.
	if (!planHasWork(plan)) {
		return { kind: 'unchanged', message: 'No speaker names to change.' };
	}
	await rememberNames(deps, request.profileId, entries);
	const applied = await applySpeakerRenamesWithSidecar(
		deps.app,
		deps.file,
		section,
		plan.renames,
		{ allowBroad: request.allowBroad },
	);
	// One atomic commit: the roster, its history entry, and the names this
	// apply introduced can never be persisted without each other, so the undo
	// baseline always matches what was actually applied. A name that was in
	// neither the recording's roster nor the picked profile joins the
	// recording here (and the profile in rememberNames above), so it is
	// suggested next time from the recording itself. An apply that only healed
	// the outputs has no assignment to record and must not append a history
	// entry, which undo would then step through for nothing.
	if (plan.changed) {
		await deps.sidecar.commitRename(
			deps.file.path,
			plan.nextEntries,
			plan.nextNames,
			{
				names: Object.values(plan.nextNames),
				profileId: request.profileId,
			},
		);
	}
	return {
		kind: 'applied',
		message: describeRenameOutcome(applied, {
			broadOptInHint: request.broadOptInHint,
			ambiguous: plan.ambiguous,
		}),
		counts: describeRenameCounts(applied),
	};
}

/**
 * Reverts the last applied rename: the roster returns to the assignment
 * before it (the second-newest history entry, or the bare engine labels when
 * the history holds a single apply), the outputs are rewritten through the
 * same plan/apply path, and the undone entry is removed from the history - so
 * each undo walks one step further back instead of ping-ponging.
 *
 * A merge is the one rename this cannot walk back: both speakers render as
 * the same text by now, so the plan reports that text as ambiguous and the
 * outputs keep it while the roster steps back.
 * @param deps - What the rename reaches
 * @param section - The stored roster
 * @param allowBroad - Whether notes without timecode links may be rewritten
 * @returns What to tell the user
 */
export async function undoSpeakerRename(
	deps: SpeakerRenameDeps,
	section: TranscriptSection,
	allowBroad: boolean,
): Promise<string> {
	const previous =
		section.history.length >= 2
			? (section.history[section.history.length - 2]?.names ?? {})
			: {};
	const plan = planSpeakerRename(section.speakers, (label) =>
		Object.hasOwn(previous, label) ? (previous[label] ?? '') : '',
	);
	let message = 'Nothing to undo: the names are already the same.';
	// Same split as apply: an output can still show the name this undo
	// reverses while the roster already reads the older one, and the healing
	// rules are what reach it.
	if (planHasWork(plan)) {
		const applied = await applySpeakerRenamesWithSidecar(
			deps.app,
			deps.file,
			section,
			plan.renames,
			{ allowBroad },
		);
		await deps.sidecar.setSpeakers(deps.file.path, plan.nextEntries);
		// No opt-in advice here: it would advise an apply, which walks the
		// names forward rather than back.
		message = describeRenameOutcome(applied, {
			broadOptInHint: '',
			ambiguous: plan.ambiguous,
		});
	}
	// The undone entry is consumed either way, so the next undo steps further
	// back instead of replaying this one. Unlike apply, the two writes need no
	// atomic commit: if this pop fails after the roster reverted, the next
	// undo finds the roster already equal to the entry's state, plans no
	// change, and only pops - the tear heals itself instead of corrupting the
	// baseline.
	await deps.sidecar.popHistory(deps.file.path);
	return message;
}

/**
 * Adds the typed names to a participant profile, so they are suggested for
 * the next recording that picks it. A no-op when no profile is picked or
 * nothing was typed - the recording's own roster grows either way, in the
 * atomic commit of the apply.
 * @param deps - What the rename reaches
 * @param profileId - The profile, '' for none
 * @param entries - The typed entries
 */
async function rememberNames(
	deps: SpeakerRenameDeps,
	profileId: string,
	entries: readonly SpeakerNameEntry[],
): Promise<void> {
	if (!profileId) {
		return;
	}
	const names = entries
		.map((entry) => entry.name.trim())
		.filter((name) => name.length > 0);
	if (names.length === 0) {
		return;
	}
	const settings = deps.getSettings();
	const target = findProfile(settings.profiles, profileId);
	if (!target) {
		return;
	}
	// The roster only feeds the suggestions of the next recording, and the
	// rename is what was applied: a roster that cannot be written is
	// reported, and the rename goes ahead.
	try {
		// A roster kept in a note grows in the note. Its body is only the text
		// last read from there, so a name added to the body alone would be
		// gone with the next read.
		if (
			target.kind === ProfileKindId.Participants &&
			target.sourcePath !== undefined
		) {
			const profileText = new ProfileTextSource(deps.app.vault);
			const note = profileText.note(target);
			if (!note) {
				deps.notify(
					`${profileText.missingNote(target.name, target.sourcePath)}, so the new names were not added to it.`,
				);
				return;
			}
			await appendParticipantsToNote(deps.app.vault, note, names);
			return;
		}
		// Undefined is a roster that did not grow - every name typed was
		// already in it - and there is then nothing to save.
		const grown = addParticipantsToProfile(
			settings.profiles,
			profileId,
			names,
		);
		if (grown) {
			settings.profiles = grown;
			await deps.saveSettings();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to add names to profile ${target.name}:`,
			error,
		);
		deps.notify(
			`The new names were not added to profile "${target.name}": ${message}`,
		);
	}
}

/**
 * One-line count summary for the debug log.
 * @param applied - Counts of what the rename touched
 */
export function describeRenameCounts(
	applied: SpeakerRenameApplyResult,
): string {
	return (
		`${String(applied.updatedNotes)} note(s) and ` +
		`${String(applied.updatedTranscriptFiles)} transcript file(s) ` +
		`updated, ${String(applied.unscopableNotes)} note(s) unscopable, ` +
		`${String(applied.alreadyCurrentNotes)} note(s) already current, ` +
		`${String(applied.unmatchedNotes)} note(s) unmatched, ` +
		`${String(applied.missingOutputs)} recorded output(s) missing, ` +
		`${String(applied.failed)} failed`
	);
}

/**
 * The outcome sentence, built from what the rename actually touched.
 * @param applied - Counts of rewritten notes and files
 * @param options - `broadOptInHint` says how to rewrite an unscopable note
 *   ('' where only an apply could, so nothing is advised); `ambiguous` are the
 *   display texts a merge left shared, which no rule may touch
 */
export function describeRenameOutcome(
	applied: SpeakerRenameApplyResult,
	options: { broadOptInHint: string; ambiguous: readonly string[] },
): string {
	const targets: string[] = [];
	if (applied.updatedNotes > 0) {
		const plural = applied.updatedNotes > 1 ? 's' : '';
		targets.push(`${String(applied.updatedNotes)} note${plural}`);
	}
	if (applied.updatedTranscriptFiles > 0) {
		const plural = applied.updatedTranscriptFiles > 1 ? 's' : '';
		targets.push(
			`${String(applied.updatedTranscriptFiles)} transcript file${plural}`,
		);
	}
	const failed =
		applied.failed > 0
			? ` ${String(applied.failed)} output${
					applied.failed > 1 ? 's' : ''
				} could not be updated.`
			: '';
	// This note was never attempted, so naming the labels would be a guess and
	// a misleading one: they are usually intact, and the opt-in is what
	// rewrites them.
	const unscopable =
		applied.unscopableNotes > 0
			? ` ${String(applied.unscopableNotes)} note(s) carry no ` +
				'timecode link for this recording' +
				(options.broadOptInHint
					? `; ${options.broadOptInHint}`
					: ' and were left as they are.')
			: '';
	// Read back from the note rather than inferred: it shows these names
	// already, so there was nothing to do and nothing to warn about.
	const alreadyCurrent =
		applied.alreadyCurrentNotes > 0
			? ` ${String(applied.alreadyCurrentNotes)} note(s) already ` +
				'use these names.'
			: '';
	// This one was attempted and holds neither the old text nor the new one,
	// so the rendered labels really are gone, whether an LLM pass restructured
	// the body or the note was edited by hand.
	const unmatched =
		applied.unmatchedNotes > 0
			? ` ${String(applied.unmatchedNotes)} note(s) no longer carry ` +
				'the speaker labels they were written with and were left ' +
				'as they are.'
			: '';
	// A recorded output whose path no longer resolves (the note or file was
	// renamed or deleted) is skipped; said instead of an unqualified success,
	// since the next transcription is what re-records the current outputs.
	const missing =
		applied.missingOutputs > 0
			? ` ${String(applied.missingOutputs)} recorded output(s) no ` +
				'longer exist and were skipped; transcribe again to ' +
				'refresh them.'
			: '';
	// The one outcome nobody can act on: merged speakers render as one text,
	// so a later assignment that wants them apart again has nothing to tell
	// their lines apart by.
	const ambiguous =
		options.ambiguous.length > 0
			? ` Left as it is: ${options.ambiguous
					.map((name) => `"${name}"`)
					.join(', ')} - shown by more than one speaker, and ` +
				'merged lines are the same text, so nothing can tell them ' +
				'apart again. Transcribe the recording again for separate ' +
				'labels.'
			: '';
	const rest = `${unscopable}${alreadyCurrent}${unmatched}${missing}${failed}${ambiguous}`;
	if (targets.length === 0) {
		return `No speaker labels were rewritten.${rest}`;
	}
	return `Renamed speakers in ${targets.join(' and ')}.${rest}`;
}
