/**
 * Structures a recording's existing transcript with a note template, without
 * transcribing it again.
 *
 * Trying another template on the same meeting should cost the template's
 * calls and nothing else: the recognition does not change, and a paid engine
 * would bill it again on every attempt. The transcript is the one chapter
 * generation reads, found through the recording's sidecar or its notes, and
 * the note the template writes is inserted where a transcript goes, under the
 * configured heading. The chapters the recording already has are there for
 * the template to write, which a transcription run cannot offer, since its
 * chapters come after the note.
 * @module transcription/TranscriptStructurer
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import { formatChapterOutline } from '../chapters/chapterExport';
import type { TranscriptLinesSource } from '../chapters/transcriptSources';
import { MARKER_KIND, type PlayerMarker } from '../markers/markerModel';
import { timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import { vendorMaxTokens } from '../providers/providers';
import { readProfileNotes } from '../settings/ProfileNoteStore';
import { resolveDictionaryTermList } from '../settings/profileResolution';
import {
	findProfile,
	ProfileKindId,
	setSelectedProfileId,
} from '../settings/profiles';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../settings/settingsSchema';
import type { AppliedTemplate } from '../sidecar/recordingSidecarModel';
import { TemplateRenderError } from '../templates/TemplateEngine';
import type { Transcript, TranscriptSegment } from './TranscriptTypes';
import { createLlmProvider } from './factories';
import type { LlmProvider } from './llm/LlmProvider';
import type { LlmCostSink } from './llm/llmStep';
import { jobVendorId, LlmJobId } from './llm/vendors';
import { promptExpander } from './runFacts';
import {
	formatTranscriptMarkdown,
	transcriptMarkdownOptions,
} from './transcriptFormat';
import type { TemplateOutput } from './llmPostProcess';
import { writeTemplateNote } from './templateNoteOutput';
import {
	noteRendering,
	type TemplateNote,
	TemplatePass,
	withTemplateProfileNotes,
} from './templatePass';

/** The sidecar this service reads chapters from and records the apply in. */
export interface StructurerSidecar {
	/** The recording's markers, its chapters among them. */
	getMarkers(path: string): Promise<PlayerMarker[]>;
	/** Records the template a recording's note was structured with. */
	recordAppliedTemplate(
		path: string,
		applied: AppliedTemplate,
	): Promise<void>;
}

/** Collaborators the service takes, replaced in tests. */
export interface StructurerDeps {
	/** Builds the LLM the template's parts are asked of. */
	readonly createLlm?:
		| ((
				settings: AudioRecorderSettings,
				vendorId: LlmProviderId,
		  ) => LlmProvider)
		| undefined;
	/** Where the calls' spending is reported. */
	readonly costSink?: LlmCostSink | undefined;
}

/** One structuring of one recording. */
export interface StructureRequest {
	/** The recording. */
	readonly file: TFile;
	/**
	 * The recording's note, which the result goes into or links to; '' for
	 * none, when the result is written as a note of its own.
	 */
	readonly notePath: string;
	/** Id of the note template profile to apply. */
	readonly templateId: string;
	/** Where the note goes for this run; the settings' choice when absent. */
	readonly output?: TemplateOutput | undefined;
	/** The recording's transcript, as the dialog found it. */
	readonly source: TranscriptLinesSource;
	/** Ends the run when the user cancels. */
	readonly signal?: AbortSignal | undefined;
}

/** What a structuring came to, in the words the user is told. */
export interface StructureOutcome {
	/** Whether the note was written. */
	readonly written: boolean;
	/** What happened, for a notice or the command line's answer. */
	readonly message: string;
}

/**
 * A transcript of the lines a source found: one segment per line, ending
 * where the next one starts. The speaker stays in the line's text, as the
 * source wrote it, so the model still sees who said what.
 * @param source - The located transcript
 */
export function transcriptFromLines(source: TranscriptLinesSource): Transcript {
	const segments: TranscriptSegment[] = source.lines.map((line, index) => ({
		start: line.time,
		end: source.lines[index + 1]?.time ?? line.time,
		text: line.text,
	}));
	return {
		segments,
		speakers: [],
		...(source.language ? { language: source.language } : {}),
	};
}

/**
 * The chapters among a recording's markers, which a template lists with
 * `{{chapters}}` and splits the transcript under with `chapters=`.
 * @param markers - The recording's markers
 */
export function chaptersOf(markers: readonly PlayerMarker[]): PlayerMarker[] {
	return markers.filter((marker) => marker.kind === MARKER_KIND.chapter);
}

/**
 * What the user is told when the note could not be written.
 * @param request - The structuring
 */
function unwrittenMessage(request: StructureRequest): string {
	return request.notePath === ''
		? `Could not write the note for ${request.file.name}.`
		: `Could not write to ${request.notePath}; the note may have been moved or deleted.`;
}

/** Applies note templates to transcripts a recording already has. */
export class TranscriptStructurer {
	private readonly createLlm: (
		settings: AudioRecorderSettings,
		vendorId: LlmProviderId,
	) => LlmProvider;
	private readonly costSink: LlmCostSink | undefined;

	/**
	 * @param app - Obsidian App
	 * @param getSettings - Returns the current settings
	 * @param sidecar - The recordings' sidecar store
	 * @param deps - The LLM factory and cost sink, replaced in tests
	 */
	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly sidecar: StructurerSidecar,
		deps: StructurerDeps = {},
	) {
		this.createLlm = deps.createLlm ?? createLlmProvider;
		this.costSink = deps.costSink;
	}

	/**
	 * Structures the transcript with the template and inserts the note.
	 * Every outcome is a message, so the dialog and the command line say the
	 * same; the method does not throw.
	 * @param request - The recording, the note, the template and the lines
	 */
	async structure(request: StructureRequest): Promise<StructureOutcome> {
		const { templateId } = request;
		try {
			const settings = await this.runSettings(templateId);
			const template = findProfile(settings.profiles, templateId);
			if (template?.kind !== ProfileKindId.LlmTemplate) {
				return {
					written: false,
					message: 'That note template no longer exists.',
				};
			}
			const note = await this.buildNote(request, settings, template);
			return await this.insert(request, settings, note, template);
		} catch (error) {
			return this.failure(request, error);
		}
	}

	/**
	 * The settings the run reads: the current ones with the template picked
	 * for it, and the notes of every profile they use read now.
	 * @param templateId - The template to apply
	 */
	private async runSettings(
		templateId: string,
	): Promise<AudioRecorderSettings> {
		const run = { ...this.getSettings() };
		setSelectedProfileId(run, ProfileKindId.LlmTemplate, templateId);
		const read = await readProfileNotes(this.app, run);
		return (await withTemplateProfileNotes(this.app, read)).settings;
	}

	/**
	 * The note the template writes from the transcript.
	 * @param request - The structuring
	 * @param settings - The run's settings
	 * @param template - The template to apply
	 */
	private async buildNote(
		request: StructureRequest,
		settings: AudioRecorderSettings,
		template: { readonly name: string; readonly body: string },
	): Promise<TemplateNote> {
		const { file, notePath, source, signal } = request;
		const transcript = transcriptFromLines(source);
		const links = timecodeLinkBuilder(this.app, file, notePath);
		// Read from a note or a file, the lines carry their own timecodes as
		// text, so the transcript is written without links of its own.
		const options = {
			...transcriptMarkdownOptions(settings),
			timestampLinks: false,
		};
		const facts = {
			app: this.app,
			settings,
			recording: file,
			notePath,
			transcript,
		};
		const vendorId = jobVendorId(settings, LlmJobId.PostProcess);
		const chapterMarkers = chaptersOf(
			await this.sidecar.getMarkers(file.path),
		);
		return new TemplatePass({
			template: template.body,
			templateName: template.name,
			source: facts,
			transcriptMarkdown: formatTranscriptMarkdown(
				transcript,
				options,
				links,
			),
			expandPrompt: promptExpander(facts),
			glossary: resolveDictionaryTermList(settings),
			rendering: noteRendering(
				transcript,
				options,
				links,
				chapterMarkers.map((marker) => ({
					start: marker.time,
					title: marker.label,
				})),
			),
			chapters: formatChapterOutline(chapterMarkers, links),
			llm: this.createLlm(settings, vendorId),
			maxTokens: vendorMaxTokens(settings, vendorId),
			costSink: this.costSink,
			signal,
		}).run();
	}

	/**
	 * Writes the note where the run sends it, and records which template
	 * wrote it.
	 * @param request - The structuring
	 * @param settings - The run's settings
	 * @param note - The note the template wrote
	 * @param template - The template applied
	 */
	private async insert(
		request: StructureRequest,
		settings: AudioRecorderSettings,
		note: TemplateNote,
		template: { readonly id: string; readonly name: string },
	): Promise<StructureOutcome> {
		const { file, notePath } = request;
		const written = await writeTemplateNote(this.app, {
			recording: file,
			notePath,
			markdown: note.markdown,
			heading: settings.transcriptHeading,
			templateName: template.name,
			properties: note.properties,
			output: request.output ?? settings.llmTemplateOutput,
		});
		if (written === null) {
			return { written: false, message: unwrittenMessage(request) };
		}
		await this.sidecar.recordAppliedTemplate(file.path, {
			profileId: template.id,
			name: template.name,
			appliedAt: new Date().toISOString(),
		});
		return {
			written: true,
			message: `Structured ${file.name} with "${template.name}" into ${written}.`,
		};
	}

	/**
	 * What a structuring that did not finish tells the user.
	 * @param request - The structuring
	 * @param error - Why it stopped
	 */
	private failure(
		request: StructureRequest,
		error: unknown,
	): StructureOutcome {
		if (request.signal?.aborted) {
			return { written: false, message: 'Structuring cancelled.' };
		}
		if (!(error instanceof TemplateRenderError)) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Structuring ${request.file.path} failed:`,
				error,
			);
		}
		return {
			written: false,
			message: `Could not structure the transcript: ${errorMessage(error)}`,
		};
	}
}
