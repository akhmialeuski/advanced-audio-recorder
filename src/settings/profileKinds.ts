/**
 * The kinds of profile the plugin keeps, described once each.
 *
 * A glossary, a chapter-guidance prompt, a participant roster, and a
 * post-processing prompt are the same thing four times over, and
 * {@link module:settings/profiles} now stores them as one shape. What is left
 * per kind is what a kind actually differs in: the copy, what an entry says
 * about itself, and which block of the settings shows it.
 *
 * A kind is one descriptor, and the settings build every catalogue from this
 * list rather than from a block per kind. Adding another kind is an entry
 * here, and it arrives with the same rules as the rest: a dropdown that picks
 * it, a page per profile, unique names, and the same rename and delete. The
 * control keys a kind's rows bind to come from its id, so a kind cannot be
 * declared with a key that collides with another's.
 * @module settings/profileKinds
 */

import type { AudioRecorderSettings } from './settingsSchema';
import type { Profile, ProfileKindId } from './profiles';
import { parseDictionary } from '../transcription/dictionary';
import { parseParticipantBody } from '../speakers/participantRoster';

/** Which block of the settings a kind's catalogue belongs to. */
export type ProfileSection = 'transcription' | 'advanced' | 'chapters' | 'llm';

/** Everything the plugin knows about one kind of profile. */
export interface ProfileKind {
	/** The kind these profiles carry, and the source of its control keys. */
	readonly id: ProfileKindId;
	/** Block of the settings whose rows this kind belongs among. */
	readonly section: ProfileSection;
	/** Heading of the catalogue, e.g. "Dictionary profiles". */
	readonly heading: string;
	/** Description of the entry that opens the catalogue. */
	readonly catalogueDesc: string;
	/** Label and description of the row that picks the profile in use. */
	readonly selectionName: string;
	readonly selectionDesc: string;
	/** Label and description of the body field on a profile's page. */
	readonly bodyName: string;
	readonly bodyDesc: string;
	/** Control key namespace of the row that selects a profile. */
	readonly selectionKey: string;
	/** Control key namespace the body is bound to, per profile. */
	readonly bodyKey: string;
	/** What a profile's entry says about it without being opened. */
	readonly summary: (profile: Profile) => string;
	/** Whether this kind is on screen at all. */
	readonly visible: (settings: AudioRecorderSettings) => boolean;
}

/** A kind as it is declared: the keys are the id's to give, not the author's. */
type ProfileKindSpec = Omit<ProfileKind, 'selectionKey' | 'bodyKey'>;

/**
 * Completes a declared kind with the control keys its rows bind to. The keys
 * are derived from the id rather than written out, so two kinds can no more
 * share a key than they can share an id.
 * @param spec - The kind as declared
 * @returns The kind the settings read
 */
function defineKind(spec: ProfileKindSpec): ProfileKind {
	return {
		...spec,
		selectionKey: `profile.${spec.id}.selection`,
		bodyKey: `profile.${spec.id}.body`,
	};
}

/**
 * What a body of one entry per line says about itself: how many entries a run
 * would actually use, counted the way the run counts them, so a body of blank
 * lines does not read as a full list.
 * @param count - Entries the run would use
 * @param one - Singular noun, e.g. "term"
 * @param many - Plural noun, e.g. "terms"
 */
function countSummary(count: number, one: string, many: string): string {
	if (count === 0) {
		return `No ${many}`;
	}
	return count === 1 ? `1 ${one}` : `${String(count)} ${many}`;
}

/**
 * What a prompt body says about itself. A prompt has no countable entries, so
 * the entry says whether the profile carries one at all.
 * @param profile - The profile being summarized
 * @returns The entry's summary line
 */
function promptSummary(profile: Profile): string {
	return profile.body.trim() === '' ? 'No prompt' : 'Prompt set';
}

/** Whether the LLM post-processing pass runs at all, as configured. */
function postProcessing(settings: AudioRecorderSettings): boolean {
	return settings.transcriptionEnabled && settings.llmPostProcessEnabled;
}

/**
 * The description of the row that picks a prompt for a task the plugin ships a
 * prompt for. Cleanup and summary run their built-in prompt when no profile
 * applies, so both say so in the same words.
 * @param what - What the prompt steers, e.g. "the cleanup pass"
 * @returns The row's description
 */
function promptSelectionDesc(what: string): string {
	return `Prompt used for ${what}; None falls back to the built-in default.`;
}

/**
 * Every kind of profile, in the order the settings show them. Which block each
 * one belongs to is the kind's own `section`, and the settings tree filters the
 * catalogues it built from this list by it, so there is no second answer here
 * to the same question.
 */
export const PROFILE_KINDS: readonly ProfileKind[] = [
	defineKind({
		id: 'participants',
		section: 'transcription',
		heading: 'Participant profiles',
		catalogueDesc:
			'Named rosters of people. The one a run carries is written into the recording, so renaming speakers suggests the right names.',
		selectionName: 'Participant profile',
		selectionDesc:
			'Roster offered by default in the Transcribe dialog; None carries no names.',
		bodyName: 'Participants',
		bodyDesc:
			'One name per line. Blank lines and duplicates are ignored, and a name applied in the rename dialog is added here.',
		summary: (profile) =>
			countSummary(
				parseParticipantBody(profile.body).length,
				'name',
				'names',
			),
		visible: (settings) =>
			settings.transcriptionEnabled && settings.transcriptionDiarize,
	}),
	defineKind({
		id: 'dictionary',
		section: 'advanced',
		heading: 'Dictionary profiles',
		catalogueDesc:
			'Named glossaries of names, abbreviations, and domain terms. Pick one, or None, per run in the Transcribe dialog.',
		selectionName: 'Dictionary profile',
		selectionDesc:
			'Glossary offered by default in the Transcribe dialog; None applies no terms.',
		bodyName: 'Terms',
		bodyDesc:
			'One term per line. A term may contain spaces; blank lines and case-insensitive duplicates are ignored.',
		summary: (profile) =>
			countSummary(parseDictionary(profile.body).length, 'term', 'terms'),
		visible: (settings) =>
			settings.transcriptionEnabled &&
			settings.transcriptionAdvancedSettingsEnabled,
	}),
	defineKind({
		id: 'chapterPrompt',
		section: 'chapters',
		heading: 'Chapter guidance profiles',
		catalogueDesc:
			'Named prompts describing how to divide a recording into chapters. The response format is fixed, so editing one is safe.',
		selectionName: 'Chapter guidance profile',
		selectionDesc:
			'Prompt used by default when chapters are generated; None leaves the base behaviour.',
		bodyName: 'Guidance prompt',
		bodyDesc:
			'How to divide the recording into chapters. Appended to the fixed base prompt; blank leaves the base behaviour.',
		summary: promptSummary,
		// Follows the chapters switch alone: the guidance steers a generation,
		// and a generation is offered on any recording that already has a
		// transcript, whether or not this vault still transcribes new ones.
		visible: (settings) => settings.transcriptionAutoChaptersEnabled,
	}),
	defineKind({
		id: 'llmCleanup',
		section: 'llm',
		heading: 'Cleanup prompt profiles',
		catalogueDesc:
			'Named system instructions for the cleanup pass. Keep one per kind of recording instead of rewriting the single prompt each time.',
		selectionName: 'Cleanup prompt profile',
		selectionDesc: promptSelectionDesc('the cleanup pass'),
		bodyName: 'Cleanup prompt',
		bodyDesc:
			'System instruction for the cleanup pass. The transcript language is appended automatically.',
		summary: promptSummary,
		visible: (settings) =>
			postProcessing(settings) &&
			settings.llmPostProcessTask === 'cleanup',
	}),
	defineKind({
		id: 'llmSummary',
		section: 'llm',
		heading: 'Summary prompt profiles',
		catalogueDesc:
			'Named system instructions for the summary pass, so a standup and a client call can be summarized on their own terms.',
		selectionName: 'Summary prompt profile',
		selectionDesc: promptSelectionDesc('the summary pass'),
		bodyName: 'Summary prompt',
		bodyDesc:
			'System instruction for the summary pass. The transcript language is appended automatically.',
		summary: promptSummary,
		visible: (settings) =>
			postProcessing(settings) &&
			settings.llmPostProcessTask === 'summary',
	}),
	defineKind({
		id: 'llmCustom',
		section: 'llm',
		heading: 'Custom instruction profiles',
		catalogueDesc:
			'Named instructions applied to the transcript verbatim. One per task you run the transcript through.',
		selectionName: 'Custom instruction profile',
		// Not the shared sentence: the custom task ships no prompt of its own,
		// so None leaves the model with a neutral instruction to do something
		// unstated rather than with a default worth running.
		selectionDesc:
			'Instruction used for the custom task; None leaves only a neutral instruction, so the pass does little.',
		bodyName: 'Custom instruction',
		bodyDesc:
			'System instruction applied to the transcript text, sent verbatim: no language clause is added.',
		summary: promptSummary,
		visible: (settings) =>
			postProcessing(settings) &&
			settings.llmPostProcessTask === 'custom',
	}),
];
