/**
 * Builds a note from a template whose parts a model fills.
 *
 * The template is rendered once to learn which parts this run asks for, the
 * parts are asked for in as few calls as their settings allow, each answer is
 * read and written into Markdown by the part's format, and the template is
 * rendered again with every result in its place.
 *
 * One call that fails costs only its own parts: they come out empty, the rest
 * of the note is still written, and a notice names what is missing. Only a run
 * in which every call failed is a failure of the pass, which then keeps the
 * plain transcript as any failed post-processing does.
 * @module transcription/templatePass
 */

import { type App, Notice } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { findPartProfile } from '../settings/profileResolution';
import {
	type ProfileNotesRead,
	readProfileNotes,
} from '../settings/ProfileNoteStore';
import { ProfileKindId, selectedProfile } from '../settings/profiles';
import { declaredParts } from '../templates/noteTemplateCheck';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	CHAPTERS_VARIABLE,
	type PartSpec,
	assembleNote,
	collectParts,
	noteTemplateEngine,
} from '../templates/noteTemplate';
import { CALLOUT_FORMAT, formatOf } from '../templates/partFormats';
import { inCallout } from '../templates/partRenderers';
import {
	PROPERTIES_ROOT,
	type RunFacts,
	runTemplateContext,
} from '../templates/runVariables';
import {
	type NoteProperties,
	noteProperties,
} from '../templates/partProperties';
import type { TemplateContext } from '../templates/TemplateEngine';
import {
	TRANSCRIPT_HELPER,
	type TranscriptRenderer,
	transcriptHelper,
} from '../templates/transcriptPart';
import {
	type TimecodeLinkBuilder,
	type TranscriptChapter,
	type TranscriptMarkdownOptions,
	type TranscriptTurn,
	formatTranscriptByChapters,
	formatTranscriptMarkdown,
	transcriptTurns,
} from './transcriptFormat';
import type { Transcript } from './TranscriptTypes';
import { formatTimecode } from '../utils/TimeUtils';
import type { LlmProvider } from './llm/LlmProvider';
import { type LlmCostSink, runLlmStep } from './llm/llmStep';
import { withTemplaterCommandsRun } from './templaterStep';
import { LlmJobId } from './llm/vendors';
import {
	collectRunFacts,
	type PromptExpander,
	type RunFactsSource,
} from './runFacts';
import {
	type PromptPart,
	buildTemplatePrompt,
	readTemplateAnswer,
} from './templatePrompt';

/** Everything one template pass needs. */
export interface TemplatePassRequest {
	/** The template, as the selected profile holds it. */
	readonly template: string;
	/** Name of the template's profile, for what the user is told. */
	readonly templateName: string;
	/** Where the facts of the run are read from; carries the settings. */
	readonly source: RunFactsSource & {
		readonly settings: AudioRecorderSettings;
	};
	/** The transcript written the way the note writes it. */
	readonly transcriptMarkdown: string;
	/** Fills the facts of the run into a profile a part names. */
	readonly expandPrompt: PromptExpander;
	/** Canonical spellings of names and terms. */
	readonly glossary: readonly string[];
	/** How the run writes the transcript and links into it. */
	readonly rendering?: NoteRendering | undefined;
	/** The recording's chapters as a linked list; '' or absent for none. */
	readonly chapters?: string | undefined;
	readonly llm: LlmProvider;
	readonly maxTokens: number;
	readonly costSink?: LlmCostSink | undefined;
	readonly signal?: AbortSignal | undefined;
}

/**
 * Ids of the prompt profiles the selected note template names, so a run
 * reads the notes they are kept in before it starts, as it does for the
 * profiles it has selected.
 * @param settings - The run's settings
 * @returns The ids, none when no template is selected
 */
export function templateProfileIds(settings: AudioRecorderSettings): string[] {
	const template = selectedProfile(settings, ProfileKindId.LlmTemplate);
	if (!template) {
		return [];
	}
	return declaredParts(template.body).flatMap((part) => {
		const profile =
			part.profile === undefined
				? undefined
				: findPartProfile(settings.profiles, part.profile);
		return profile ? [profile.id] : [];
	});
}

/**
 * The settings of a run with the notes of the prompt profiles its note
 * template names read as well, on top of the ones the run had read already:
 * which profiles those are, only the template itself says.
 * @param app - Obsidian App
 * @param read - The run's settings with its selected profiles read
 * @returns The settings with both read, and every profile left unread
 */
export async function withTemplateProfileNotes(
	app: App,
	read: ProfileNotesRead,
): Promise<ProfileNotesRead> {
	const named = templateProfileIds(read.settings);
	if (named.length === 0) {
		return read;
	}
	const again = await readProfileNotes(app, read.settings, named);
	return {
		settings: again.settings,
		unread: new Set([...read.unread, ...again.unread]),
	};
}

/** How a run writes its transcript and links into its recording. */
export interface NoteRendering {
	/** A link to a moment of the recording, labelled with its timecode. */
	readonly links: (seconds: number) => string;
	/** The transcript lines, with a template's overrides. */
	readonly renderTranscript: TranscriptRenderer;
	/** The speaker turns a template repeats. */
	readonly turns: readonly TranscriptTurn[];
}

/**
 * How a run's transcript is written into a note template: with the run's
 * options, as `{{transcript}}` overrides them, and as the turns
 * `{{#each turns}}` repeats.
 * @param transcript - The finished transcript
 * @param options - How the note writes the transcript
 * @param links - Builds a link to a moment of the recording
 * @param chapters - The recording's chapters, which `chapters=` splits the
 *   transcript under; none in a transcription run, which writes them later
 */
export function noteRendering(
	transcript: Transcript,
	options: TranscriptMarkdownOptions,
	links: TimecodeLinkBuilder,
	chapters: readonly TranscriptChapter[] = [],
): NoteRendering {
	return {
		links: (seconds) => links(seconds, formatTimecode(seconds)),
		renderTranscript: (overrides) => {
			const lines = {
				...options,
				includeTimestamps:
					overrides.timestamps ?? options.includeTimestamps,
				includeSpeakers: overrides.speakers ?? options.includeSpeakers,
			};
			return overrides.chapters !== undefined
				? formatTranscriptByChapters(
						transcript,
						lines,
						links,
						chapters,
						overrides.chapters,
					)
				: formatTranscriptMarkdown(transcript, lines, links);
		},
		turns: transcriptTurns(
			transcript,
			options.mergeConsecutiveSpeaker,
			links,
		),
	};
}

/** The note a template wrote, and what it changed about the transcript. */
export interface TemplateNote {
	readonly markdown: string;
	/** The properties its parts write to the note; none for a plain task. */
	readonly properties: NoteProperties;
	/** Name of the template that wrote it; undefined for a plain task. */
	readonly templateName?: string | undefined;
	/**
	 * Whether the transcript lines carry timestamps, when the template said;
	 * undefined when it kept the setting or wrote no transcript.
	 */
	readonly timestamps: boolean | undefined;
}

/** The parts asked for in one call. */
type CallGroup = readonly PromptPart[];

/**
 * The calls a set of parts is asked for in: one for every part that shares,
 * and one more for each part that asked to be separate.
 * @param parts - The parts with their instructions
 */
export function groupCalls(parts: readonly PromptPart[]): CallGroup[] {
	const shared = parts.filter((part) => !part.spec.separate);
	return [
		...(shared.length > 0 ? [shared] : []),
		...parts.filter((part) => part.spec.separate).map((part) => [part]),
	];
}

/**
 * The Markdown of one part from the model's answer for it.
 * @param spec - The part
 * @param answer - What the model answered; undefined for nothing
 * @param links - Writes a link to a moment of the recording
 */
export function renderPart(
	spec: PartSpec,
	answer: unknown,
	links?: (seconds: number) => string,
): string {
	if (answer === undefined || answer === null) {
		return '';
	}
	const format = formatOf(spec.format);
	const shape = { max: spec.max, options: spec.options, links };
	const markdown = format.render(format.read(answer, shape), shape).trim();
	// A callout part is its own callout; any other is put in one on request.
	return markdown === '' || format.id === CALLOUT_FORMAT
		? markdown
		: inCallout(markdown, spec.options);
}

/** Runs one template over one transcript. */
export class TemplatePass {
	constructor(private readonly request: TemplatePassRequest) {}

	/**
	 * Builds the note.
	 * @returns The note's Markdown, and the timestamps it decided on
	 * @throws TemplateRenderError when the template cannot be rendered
	 * @throws Error when every call the parts needed failed
	 */
	async run(): Promise<TemplateNote> {
		const template = await withTemplaterCommandsRun(
			this.request.source,
			this.request.template,
			this.request.templateName,
		);
		const facts = collectRunFacts(
			this.request.source,
			noteTemplateEngine().fieldsRead(template, PROPERTIES_ROOT),
		);
		const { rendering } = this.request;
		const context: TemplateContext = {
			...runTemplateContext(facts),
			transcript: this.request.transcriptMarkdown,
			turns: rendering?.turns ?? [],
			[CHAPTERS_VARIABLE]: this.request.chapters ?? '',
		};
		const specs = collectParts(template, context);
		const results = await this.fillParts(specs, facts);
		return {
			...this.assemble(template, context, results),
			properties: noteProperties(specs, results),
			templateName: this.request.templateName,
		};
	}

	/**
	 * Asks the model for every part, in as few calls as their settings allow,
	 * and writes each answer as its format does.
	 * @param specs - The parts the template asks for
	 * @param facts - The facts of the run
	 * @returns Every part's Markdown by name, empty for one that failed
	 * @throws Error when every call the parts needed failed
	 */
	private async fillParts(
		specs: readonly PartSpec[],
		facts: RunFacts,
	): Promise<Map<string, string>> {
		const links = this.request.rendering?.links;
		// A part the model does not fill is its own body, and costs no call.
		const results = new Map<string, string>(
			specs.map((spec) => [
				spec.name,
				spec.asksModel ? '' : spec.instruction,
			]),
		);
		const groups = groupCalls(
			this.withInstructions(specs.filter((spec) => spec.asksModel)),
		);
		const failed: string[] = [];
		for (const group of groups) {
			const answers = await this.ask(group, facts);
			if (!answers) {
				failed.push(...group.map((part) => part.spec.name));
				continue;
			}
			for (const { spec } of group) {
				results.set(
					spec.name,
					renderPart(spec, answers.get(spec.name), links),
				);
			}
		}
		this.reportFailures(groups, failed);
		return results;
	}

	/**
	 * Tells the user which parts are missing, and fails the pass when all are.
	 * @param groups - The calls the parts were asked in
	 * @param failed - The parts whose call failed
	 * @throws Error when every call failed
	 */
	private reportFailures(
		groups: readonly CallGroup[],
		failed: readonly string[],
	): void {
		const { templateName } = this.request;
		const asked = groups.reduce((sum, group) => sum + group.length, 0);
		if (asked > 0 && failed.length === asked) {
			throw new Error(
				`no part of the note template "${templateName}" could be filled`,
			);
		}
		if (failed.length > 0) {
			new Notice(
				`The note template "${templateName}" was written without ${failed.map((name) => `"${name}"`).join(', ')}: the model could not be reached for ${failed.length === 1 ? 'it' : 'them'}.`,
			);
		}
	}

	/**
	 * The note with every part's result in its place, and the transcript
	 * written as the template asks.
	 * @param template - The template, its Templater commands run
	 * @param context - What the template reads
	 * @param results - Every part's Markdown, by name
	 */
	private assemble(
		template: string,
		context: TemplateContext,
		results: ReadonlyMap<string, string>,
	): Pick<TemplateNote, 'markdown' | 'timestamps'> {
		const { rendering } = this.request;
		let timestamps: boolean | undefined;
		const helpers = rendering
			? {
					[TRANSCRIPT_HELPER]: transcriptHelper((overrides) => {
						timestamps = overrides.timestamps;
						return rendering.renderTranscript(overrides);
					}),
				}
			: {};
		const markdown = assembleNote(template, context, results, helpers);
		return { markdown, timestamps };
	}

	/**
	 * The instruction of every part: its block's own, or the body of the
	 * profile it names, filled in with the facts of the run. A part naming a
	 * profile that is not there is left out and named in a notice, rather than
	 * sent to the model with no instruction at all.
	 * @param specs - The parts the template asks for
	 */
	private withInstructions(specs: readonly PartSpec[]): PromptPart[] {
		const { settings } = this.request.source;
		const missing: string[] = [];
		const parts = specs.flatMap((spec): PromptPart[] => {
			if (spec.profile === undefined) {
				return [{ spec, instruction: spec.instruction }];
			}
			const profile = findPartProfile(settings.profiles, spec.profile);
			if (!profile) {
				missing.push(spec.profile);
				return [];
			}
			return [
				{
					spec,
					instruction: this.request.expandPrompt(profile.body).trim(),
				},
			];
		});
		if (missing.length > 0) {
			new Notice(
				`The note template "${this.request.templateName}" names prompt profiles that do not exist: ${missing.join(', ')}. Those parts were left out.`,
			);
		}
		return parts;
	}

	/**
	 * Asks for the parts of one call.
	 * @param group - The parts
	 * @param facts - The facts of the run
	 * @returns The answer per part, or undefined when the call failed
	 */
	private async ask(
		group: CallGroup,
		facts: RunFacts,
	): Promise<Map<string, unknown> | undefined> {
		const { request } = this;
		const transcript = request.source.transcript ?? {
			segments: [],
			speakers: [],
		};
		try {
			const output = await runLlmStep({
				step: LlmJobId.PostProcess,
				llm: request.llm,
				prompt: buildTemplatePrompt({
					parts: group,
					facts,
					glossary: request.glossary,
					transcript,
				}),
				maxTokens: request.maxTokens,
				settings: request.source.settings,
				durationSeconds: facts.durationSeconds,
				costSink: request.costSink,
				signal: request.signal,
			});
			return readTemplateAnswer(
				output,
				group.map((part) => part.spec.name),
			);
		} catch (error) {
			// A cancel is not a failed part: it ends the whole run.
			request.signal?.throwIfAborted();
			console.warn(
				`${PLUGIN_LOG_PREFIX} A call for the note template "${request.templateName}" failed.`,
				error,
			);
			return undefined;
		}
	}
}
