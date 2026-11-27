/**
 * The "Structure transcript with a template" action: the dialog it opens and
 * the command line run it answers, which share one structurer and one way of
 * finding the recording's transcript and note.
 * @module actions/file/structureTranscript
 */

import type { CliData, CliFlags } from 'obsidian';
import { loadTranscriptLines } from '../../chapters/transcriptSources';
import { valueParam, cliText } from '../../obsidian/cliArgs';
import { ProfileKindId, profilesOfKind } from '../../settings/profiles';
import { TemplateOutput } from '../../transcription/llmPostProcess';
import { TranscriptStructurer } from '../../transcription/TranscriptStructurer';
import {
	StructureTranscriptModal,
	initialTemplateId,
} from '../../ui/StructureTranscriptModal';
import type { ActionServices } from '../core/actionServices';
import type { FileContext } from './FileContext';

/** The parameters of the structure command, beyond its target. */
export const STRUCTURE_PARAMS: CliFlags = {
	template: valueParam(
		'<template>',
		'Note template profile, by name. Defaults to the one this recording was last structured with.',
	),
	output: valueParam(
		'<note|separate>',
		"Into the recording's note, or a note of its own next to the recording. Defaults to the setting.",
	),
};

/** The values `output=` takes, by what is typed. */
const CLI_OUTPUTS: ReadonlyMap<string, TemplateOutput> = new Map(
	Object.values(TemplateOutput).map((output) => [output, output]),
);

/**
 * Where the note goes, as typed after `output=`.
 * @param typed - What was typed, null for nothing
 * @returns The output, undefined for the setting's, or the answer when what
 *   was typed is not one
 */
function cliOutput(
	typed: string | null,
): { output: TemplateOutput | undefined } | { refusal: string } {
	if (typed === null) {
		return { output: undefined };
	}
	const output = CLI_OUTPUTS.get(typed.trim().toLowerCase());
	return output
		? { output }
		: { refusal: `output= takes ${[...CLI_OUTPUTS.keys()].join(' or ')}.` };
}

/**
 * The structurer an action runs, over the services every action shares.
 * @param services - The action services
 */
function structurerOf(services: ActionServices): TranscriptStructurer {
	return new TranscriptStructurer(
		services.app,
		services.getSettings,
		services.recordingSidecar,
		{ costSink: services.transcriptionCosts },
	);
}

/**
 * The note an action on a recording writes into: the one it was reached
 * through, else the active note, never the recording itself.
 * @param context - The recording and how it was reached
 * @returns The note's path, '' for none
 */
function targetNote({ file, origin, services }: FileContext): string {
	const note = origin.noteForDialog();
	const path =
		note === undefined
			? (services.app.workspace.getActiveFile()?.path ?? '')
			: (note?.path ?? '');
	return path === file.path ? '' : path;
}

/**
 * Opens the dialog for the recording.
 * @param context - The recording and how it was reached
 */
export function openStructureTranscript(context: FileContext): void {
	const { file, services } = context;
	new StructureTranscriptModal(services.app, file, {
		getSettings: services.getSettings,
		structurer: structurerOf(services),
		sidecar: services.recordingSidecar,
		notePath: targetNote(context),
	}).open();
}

/**
 * The template a command line run applies: the one named, matched without
 * regard to case, else the dialog's default.
 * @param context - The recording
 * @param name - The name typed, null for none
 * @returns The template's id, or the answer when no template fits
 */
async function cliTemplate(
	context: FileContext,
	name: string | null,
): Promise<{ id: string } | { refusal: string }> {
	const settings = context.services.getSettings();
	const templates = profilesOfKind(
		settings.profiles,
		ProfileKindId.LlmTemplate,
	);
	if (name !== null) {
		const named = templates.find(
			(template) => template.name.toLowerCase() === name.toLowerCase(),
		);
		return named
			? { id: named.id }
			: {
					refusal: `No note template is called "${name}". There are: ${templates.map((template) => template.name).join(', ') || 'none'}.`,
				};
	}
	const section = await context.services.recordingSidecar
		.getTranscript(context.file.path)
		.catch(() => null);
	const id = initialTemplateId(settings, section?.appliedTemplate?.profileId);
	return id === '' ? { refusal: 'There is no note template yet.' } : { id };
}

/**
 * Structures a recording's transcript from the command line, into the note
 * named beside it, or into a note of its own when none is named.
 * @param context - The recording and the note
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function structureTranscriptFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const output = cliOutput(cliText(args, 'output'));
	if ('refusal' in output) {
		return output.refusal;
	}
	const template = await cliTemplate(context, cliText(args, 'template'));
	if ('refusal' in template) {
		return template.refusal;
	}
	const source = await loadTranscriptLines(
		services.app,
		file,
		services.recordingSidecar,
	);
	if (!source || source.lines.length === 0) {
		return `No transcript found for ${file.path}. Transcribe it first.`;
	}
	const outcome = await structurerOf(services).structure({
		file,
		notePath: targetNote(context),
		templateId: template.id,
		output: output.output,
		source,
	});
	return outcome.message;
}
