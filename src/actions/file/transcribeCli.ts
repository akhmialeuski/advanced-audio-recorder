/**
 * Transcription started from the command line.
 *
 * The command runs the same transcription the dialog and the queue run, with
 * no dialog: a transcription is a paid job that can run for minutes, so it
 * shows its progress in a notice with a Cancel, as a conversion or a split
 * started from the command line does. What the dialog lets the user change for
 * one run, the command line takes as parameters, so the run is the one the
 * dialog would have made with the same choices; the `dialog` flag opens the
 * dialog instead, for choices made in the app.
 *
 * The answer comes back at once by default, saying the run was started. With
 * `wait` the command answers once the run is over, with where the transcript
 * went - which is what a script that goes on to read the transcript needs.
 * @module actions/file/transcribeCli
 */

import type { CliData, CliFlags } from 'obsidian';
import { transcriptionRefusal } from '../../settings/settingsAttention';
import { setSelectedProfileId } from '../../settings/profiles';
import { Notice } from 'obsidian';
import {
	runOutcomeNotice,
	TranscriptDestination,
	type TranscriptionRunOutcome,
} from '../../transcription/api';
import {
	CHOICES,
	MODEL_PARAM,
	PROFILES,
	SWITCHES,
	transcriptionRun,
} from '../../transcription/runOptions';
import { JobProgressNotice } from '../../ui/JobProgressNotice';
import {
	choiceParam,
	cliFlag,
	flagParam,
	valueParam,
	WAIT_FLAG,
} from '../../obsidian/cliArgs';
import type { FileContext } from './FileContext';
import { isRefusal } from '../../utils/refusal';

/** The parameters of the transcribe command, beyond its target. */
export const TRANSCRIBE_PARAMS: CliFlags = {
	language: valueParam(
		'<codes>',
		'Language code, several separated by commas, or auto.',
	),
	[MODEL_PARAM]: valueParam('<id>', 'Model of the engine the run uses.'),
	...Object.fromEntries(
		CHOICES.map((option) => [
			option.param,
			choiceParam(option.values, option.description),
		]),
	),
	...Object.fromEntries(
		SWITCHES.map((option) => [
			option.param,
			choiceParam(['on', 'off'], option.description),
		]),
	),
	...Object.fromEntries(
		PROFILES.map((option) => [
			option.param,
			valueParam('<profile>', option.description),
		]),
	),
	[WAIT_FLAG]: flagParam(
		'Answer once the transcript is written, not once the run started.',
	),
};

/** A transcript written as a file, which always sits beside its recording. */
const BESIDE = 'a transcript file next to the recording';

/**
 * Where a destination puts the transcript, in words.
 * @param destination - The run's destination
 * @param notePath - The note it was written for, '' for none
 */
function transcriptPlace(destination: string, notePath: string): string {
	if (notePath === '') {
		// Nothing goes into a note without one; every destination is a file.
		return BESIDE;
	}
	switch (destination) {
		case TranscriptDestination.Note:
			return notePath;
		case TranscriptDestination.Both:
			return `${notePath} and ${BESIDE}`;
		case TranscriptDestination.Link:
			return `${BESIDE}, linked from ${notePath}`;
		default:
			return BESIDE;
	}
}

/**
 * Says where a finished run put the transcript.
 * @param path - The recording
 * @param outcome - How the run ended
 */
export function describeTranscriptionOutcome(
	path: string,
	outcome: TranscriptionRunOutcome,
): string {
	if (outcome.status === 'cancelled') {
		return `Transcription of ${path} was cancelled in Obsidian.`;
	}
	if (outcome.status === 'failed') {
		return `Transcription of ${path} failed: ${outcome.message}`;
	}
	const where = transcriptPlace(outcome.destination, outcome.notePath);
	const missing =
		outcome.missingParts === 0
			? ''
			: ` ${String(outcome.missingParts)} part${
					outcome.missingParts === 1 ? '' : 's'
				} failed and can be transcribed again with retry-failed.`;
	return `Transcribed ${path} into ${where}.${missing}`;
}

/**
 * Starts a transcription from the command line.
 *
 * The note the transcript goes into is the one the command named, never
 * whichever note happens to be active in the app: a script cannot see which
 * one that is. With no note named, a transcript meant for a note is written as
 * a file next to the recording, as the dialog does when no note is open.
 * @param context - The recording and the note it was reached through
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function transcribeFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const live = services.getSettings();
	const read = transcriptionRun(live, args);
	if (isRefusal(read)) {
		return read.refusal;
	}
	const run = read.value;
	// Asked before anything opens: the same conditions the run refuses on, so
	// a job that cannot work is answered with its reason rather than started.
	const refusal = transcriptionRefusal(run.apply(live));
	if (refusal) {
		return refusal;
	}
	if (run.picks.length > 0) {
		// Kept as the next defaults, as a pick in the dialog is - and needed
		// there, since the chapters generated after the run read the profile
		// from the plugin settings rather than from this run's copy.
		for (const pick of run.picks) {
			setSelectedProfileId(live, pick.kind, pick.id);
		}
		await services.saveSettings();
	}
	const settled = JobProgressNotice.around(
		`Transcribing "${file.name}"`,
		async (onProgress, token) => {
			const outcome = await services.transcriber.transcribe({
				file,
				settings: run.apply(services.getSettings()),
				notePath: context.origin.note?.path ?? '',
				// Nothing measured the recording first, so an engine that
				// reports no usage leaves the run unpriced rather than guessed.
				durationSeconds: () => null,
				token,
				onProgress: (fraction, label) => {
					onProgress(
						`${label} ${String(Math.round(fraction * 100))}%`,
					);
				},
			});
			// Whoever watches the app is told how it ended, as the dialog
			// tells them; the answer on the terminal comes only with wait.
			const notice = runOutcomeNotice(outcome);
			if (notice !== null) {
				new Notice(notice);
			}
			return outcome;
		},
	);
	if (!cliFlag(args, WAIT_FLAG)) {
		return `Started transcribing ${file.path} in Obsidian.`;
	}
	return describeTranscriptionOutcome(file.path, await settled);
}
