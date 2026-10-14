/**
 * The file actions that edit what belongs to a recording rather than its
 * audio: transcribing the parts that failed, generating and exporting its
 * chapters, and deleting it - on its own, or with its links.
 *
 * Each is written once and reached from every surface: the menu and the
 * palette tell the user in a notice, the command line answers with the same
 * sentence. Where a dialog stands between the user and the job (chapters,
 * export), the command line takes the dialog's choices as parameters.
 * @module actions/recordingEdits
 */

import type { CliData, CliFlags } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { TranscriptionService } from '../transcription/TranscriptionService';
import {
	FailedPartRetry,
	serviceRunner,
	type RetryOutcome,
} from '../transcription/retryFailedParts';
import {
	applyChapterRunChoices,
	commitChapterRunSettings,
} from '../chapters/chapterRunSettings';
import {
	chapterExportText,
	ChapterExportView,
	writeChapterExportFile,
} from '../chapters/chapterExportFiles';
import { timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import { removeReferences, wholeFileReferences } from '../utils/LinkUpdater';
import { collectingNotify } from '../utils/notify';
import {
	choiceParam,
	cliChoice,
	cliFlag,
	cliText,
	flagParam,
	isRefusal,
	valueParam,
} from '../obsidian/cliArgs';
import type { ActionServices, FileContext } from './PluginAction';
import { pointsAtWholeFile } from '../obsidian/linkAtCursor';
import type { TFile } from 'obsidian';

/**
 * One sentence saying what the top-up did.
 * @param outcome - What the retry reports
 * @returns The sentence
 */
export function describeRetryOutcome(outcome: RetryOutcome): string {
	if (outcome.blocked) {
		return outcome.blocked;
	}
	const recovered = `Recovered ${String(outcome.recovered)} segment${
		outcome.recovered === 1 ? '' : 's'
	} and rewrote ${String(outcome.rewritten)} transcript file${
		outcome.rewritten === 1 ? '' : 's'
	}.`;
	return outcome.stillMissing.length === 0
		? recovered
		: `${recovered} ${String(outcome.stillMissing.length)} part${
				outcome.stillMissing.length === 1 ? '' : 's'
			} failed again.`;
}

/**
 * Tops up a recording's transcript with the parts that failed.
 *
 * Whether anything is missing cannot be known without reading the sidecar,
 * and an action's availability is decided synchronously, so the action is
 * always offered and a recording with nothing missing is told so. Offering it
 * only after something warmed a cache would hide it exactly when it is
 * wanted.
 * @param file - The recording to top up
 * @param services - Injected services
 * @returns What happened, in one sentence; never throws
 */
export async function retryFailedParts(
	file: TFile,
	services: ActionServices,
): Promise<string> {
	const retry = new FailedPartRetry(
		services.app,
		file,
		services.recordingSidecar,
		serviceRunner(
			new TranscriptionService(services.app, services.getSettings, {
				costSink: services.transcriptionCosts,
			}),
			// The same sidecar the retry reads its failed parts from, so the
			// recovered segments come back under the speaker names the user
			// assigned rather than the engine's own labels.
			services.recordingSidecar,
		),
	);
	try {
		const outcome = await retry.retry();
		if (outcome.cost) {
			// A top-up calls the same paid engine a full run does, so it goes
			// into the session total by the same rule, priced against the
			// stretches it actually sent rather than the whole recording.
			services.transcriptionCosts?.recordRun(
				outcome.cost,
				services.getSettings(),
				outcome.sentSeconds,
			);
		}
		return describeRetryOutcome(outcome);
	} catch (error) {
		console.error(
			`${PLUGIN_LOG_PREFIX} Failed to transcribe the missing parts of ${file.path}:`,
			error,
		);
		return `Could not transcribe the missing parts: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

/** Allows replacing chapters generated before. */
export const REPLACE_FLAG = 'replace';

/** The parameters of the chapters command, beyond its target. */
export const CHAPTER_PARAMS: CliFlags = {
	profile: valueParam(
		'<profile>',
		'Chapter guidance profile, or none. Kept as the default.',
	),
	llm: valueParam('<engine>', 'LLM engine. Kept as the default.'),
	model: valueParam('<model>', 'Model of that engine. Kept as the default.'),
	[REPLACE_FLAG]: flagParam('Replace the chapters generated before.'),
};

/**
 * Generates a recording's chapters from its transcript.
 *
 * The choices are the dialog's and, as there, become the stored defaults: the
 * service reads them from the settings. Chapters generated before are kept
 * unless `replace` is typed, the answer the dialog asks for before replacing.
 * @param context - The recording
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function generateChaptersFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	if (
		!cliFlag(args, REPLACE_FLAG) &&
		(await services.autoChapters.hasExistingChapters(file))
	) {
		return `${file.path} already has generated chapters. Add ${REPLACE_FLAG} to generate them again; bookmarks and chapters added by hand are kept.`;
	}
	const choices = {
		profile: cliText(args, 'profile'),
		llm: cliText(args, 'llm'),
		model: cliText(args, 'model'),
	};
	if (
		choices.profile !== null ||
		choices.llm !== null ||
		choices.model !== null
	) {
		const live = services.getSettings();
		const run = { ...live };
		const refusal = applyChapterRunChoices(run, choices);
		if (refusal) {
			return refusal;
		}
		commitChapterRunSettings(live, run);
		await services.saveSettings();
	}
	const said = collectingNotify();
	await services.autoChapters.generate(
		file,
		undefined,
		undefined,
		undefined,
		said.notify,
	);
	return said.messages.join('\n');
}

/** Every representation an export writes. */
const EXPORT_VIEWS: readonly ChapterExportView[] =
	Object.values(ChapterExportView);

/** Prints the representation instead of writing it. */
export const PRINT_FLAG = 'print';

/** The parameters of the export command, beyond its target. */
export const EXPORT_PARAMS: CliFlags = {
	format: choiceParam(
		EXPORT_VIEWS,
		'Timecoded list, cue sheet, or Markdown outline. Defaults to list.',
	),
	[PRINT_FLAG]: flagParam(
		'Print it instead of writing a file. The outline is always printed.',
	),
};

/**
 * Exports a recording's chapters and markers: the list or the cue sheet is
 * written beside the recording, as the dialog writes it; the outline, which
 * is Markdown for a note, is printed, ready for Obsidian's own `append`.
 * @param context - The recording and the note links resolve in
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function exportChaptersFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services, note } = context;
	const view = cliChoice(args, 'format', EXPORT_VIEWS);
	if (isRefusal(view)) {
		return view.refusal;
	}
	const markers = await services.recordingSidecar.getMarkers(file.path);
	if (markers.length === 0) {
		return `${file.path} has no chapters or markers to export.`;
	}
	const source = {
		file,
		markers,
		linkBuilder: timecodeLinkBuilder(services.app, file, note?.path ?? ''),
	};
	const chosen = view.value ?? ChapterExportView.List;
	if (chosen === ChapterExportView.Outline || cliFlag(args, PRINT_FLAG)) {
		return chapterExportText(chosen, source);
	}
	const written = await writeChapterExportFile(services.app, chosen, source);
	return `Markers written to ${written}.`;
}

/**
 * Deletes a recording together with its link in the note it was reached
 * through.
 *
 * With the link the menu or the cursor was on, exactly that link is removed,
 * from the open editor. Reached through a note alone - the command line names
 * a note, not a position in it - every link and embed of the whole recording
 * is removed from that note; links into it at a point, a transcript's `#t=`
 * timecodes, stay, since they are part of the lines around them.
 * @param context - The recording, its note, and the link when there is one
 * @returns What was done
 * @throws When the recording could not be moved to the trash
 */
export async function deleteRecordingWithLink(
	context: FileContext,
): Promise<string> {
	const { file, services, note, link } = context;
	const { app } = services;
	// The link the menu or the cursor was on goes with the recording when it
	// links the whole recording. A timecode link points at a moment and is
	// part of a transcript line, so the note's whole-file links go instead.
	if (link && pointsAtWholeFile(link)) {
		await app.fileManager.trashFile(file);
		link.editor.replaceRange(
			'',
			{ line: link.line, ch: link.start },
			{ line: link.line, ch: link.end },
		);
		return 'Recording and link deleted';
	}
	if (!note) {
		await app.fileManager.trashFile(file);
		return 'Recording deleted';
	}
	// Found before the file goes: a link to a file that is gone resolves to
	// nothing and could no longer be told from any other.
	const found = wholeFileReferences(app, note, file);
	await app.fileManager.trashFile(file);
	const removed = await removeReferences(app, note, found.references);
	const left: string[] = [];
	if (removed.skipped > 0) {
		left.push(
			`${String(removed.skipped)} link(s) changed since the note was last indexed and were left in place`,
		);
	}
	if (found.frontmatter > 0) {
		left.push(
			`${String(found.frontmatter)} link(s) in the properties were left in place`,
		);
	}
	return `Deleted ${file.path} and removed ${String(removed.removed)} link(s) to it from ${note.path}.${
		left.length > 0 ? ` ${left.join('; ')}.` : ''
	}`;
}
