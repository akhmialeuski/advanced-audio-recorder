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

import { Notice } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { findPartProfile } from '../settings/profileResolution';
import { ProfileKindId, selectedProfile } from '../settings/profiles';
import { declaredParts } from '../templates/noteTemplateCheck';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	type PartSpec,
	assembleNote,
	collectParts,
	noteTemplateEngine,
} from '../templates/noteTemplate';
import { partFormat, DEFAULT_PART_FORMAT } from '../templates/partFormats';
import {
	PROPERTIES_ROOT,
	type RunFacts,
	runTemplateContext,
} from '../templates/runVariables';
import type { TemplateContext } from '../templates/TemplateEngine';
import type { LlmProvider } from './llm/LlmProvider';
import { type LlmCostSink, runLlmStep } from './llm/llmStep';
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
 */
export function renderPart(spec: PartSpec, answer: unknown): string {
	const format = partFormat(spec.format) ?? partFormat(DEFAULT_PART_FORMAT);
	if (!format || answer === undefined || answer === null) {
		return '';
	}
	return format
		.render(format.read(answer), { max: spec.max, options: spec.options })
		.trim();
}

/** Runs one template over one transcript. */
export class TemplatePass {
	constructor(private readonly request: TemplatePassRequest) {}

	/**
	 * Builds the note.
	 * @returns The note's Markdown
	 * @throws TemplateRenderError when the template cannot be rendered
	 * @throws Error when every call the parts needed failed
	 */
	async run(): Promise<string> {
		const { template } = this.request;
		const facts = collectRunFacts(
			this.request.source,
			noteTemplateEngine().fieldsRead(template, PROPERTIES_ROOT),
		);
		const context: TemplateContext = {
			...runTemplateContext(facts),
			transcript: this.request.transcriptMarkdown,
		};
		const specs = collectParts(template, context);
		const parts = this.withInstructions(specs);
		const results = new Map<string, string>(
			specs.map((spec) => [spec.name, '']),
		);
		const groups = groupCalls(parts);
		const failed: string[] = [];
		let answered = 0;
		for (const group of groups) {
			const answers = await this.ask(group, facts);
			if (!answers) {
				failed.push(...group.map((part) => part.spec.name));
				continue;
			}
			answered += 1;
			for (const { spec } of group) {
				results.set(
					spec.name,
					renderPart(spec, answers.get(spec.name)),
				);
			}
		}
		if (groups.length > 0 && answered === 0) {
			throw new Error(
				`no part of the note template "${this.request.templateName}" could be filled`,
			);
		}
		if (failed.length > 0) {
			new Notice(
				`The note template "${this.request.templateName}" was written without ${failed.map((name) => `"${name}"`).join(', ')}: the model could not be reached for ${failed.length === 1 ? 'it' : 'them'}.`,
			);
		}
		return assembleNote(template, context, results);
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
