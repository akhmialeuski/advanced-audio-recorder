/**
 * The kinds of profile the plugin keeps, described once each.
 *
 * A glossary, a chapter-guidance prompt, and a participant roster are the same
 * thing three times over: a named entry in a stored list, one of which is
 * selected, holding a body the user edits as text. The list mechanics already
 * came from {@link module:settings/profiles}; what stayed apart was everything
 * around them - the copy, the body field, what an entry says about itself, and
 * which part of the settings shows it - so each kind grew its own wording and
 * its own gaps, and the rosters had no editor at all.
 *
 * A kind is now one descriptor, and the settings build every catalogue from
 * this list rather than from a block per kind. Adding another kind is an entry
 * here, and it arrives with the same rules as the rest: a dropdown that picks
 * it, a page per profile, unique names, and the same rename and delete.
 * @module settings/profileKinds
 */

import type { AudioRecorderSettings } from './settingsSchema';
import type { Profile, ProfileList } from './profiles';
import type {
	ChapterPromptProfile,
	DictionaryProfile,
	SpeakerProfile,
} from './settingsSchema';
import { DICTIONARY_PROFILES } from './dictionaryProfiles';
import { CHAPTER_PROMPT_PROFILES } from './chapterPromptProfiles';
import { SPEAKER_PROFILES } from './speakerProfiles';
import { parseDictionary } from '../transcription/dictionary';
import { normalizeParticipantNames } from '../speakers/participantRoster';

/** Which block of the settings a kind's catalogue belongs to. */
export type ProfileSection = 'transcription' | 'advanced' | 'chapters';

/** Everything the plugin knows about one kind of profile. */
export interface ProfileKind<T extends Profile = Profile> {
	/** Where this kind lives in settings, and how a fresh one is built. */
	readonly list: ProfileList<T>;
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
	/** Settings key holding the selected id. */
	readonly selectionKey: string;
	/** Control key the body is bound to, per profile. */
	readonly bodyKey: string;
	/** The body as the user edits it: text, one entry per line where it is a list. */
	readonly body: (profile: T) => string;
	readonly setBody: (profile: T, value: string) => void;
	/** What a profile's entry says about it without being opened. */
	readonly summary: (profile: T) => string;
	/** Whether this kind is on screen at all. */
	readonly visible: (settings: AudioRecorderSettings) => boolean;
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

/** Named glossaries of terms a transcription run is biased toward. */
const DICTIONARY_KIND: ProfileKind<DictionaryProfile> = {
	list: DICTIONARY_PROFILES,
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
	selectionKey: 'transcriptionDictionaryProfileId',
	bodyKey: 'dictionaryProfile.terms',
	body: (profile) => profile.terms,
	setBody: (profile, value) => {
		profile.terms = value;
	},
	summary: (profile) =>
		countSummary(parseDictionary(profile.terms).length, 'term', 'terms'),
	visible: (settings) =>
		settings.transcriptionEnabled &&
		settings.transcriptionAdvancedSettingsEnabled,
};

/** Named prompts steering how a recording is divided into chapters. */
const CHAPTER_KIND: ProfileKind<ChapterPromptProfile> = {
	list: CHAPTER_PROMPT_PROFILES,
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
	selectionKey: 'transcriptionChapterPromptProfileId',
	bodyKey: 'chapterProfile.prompt',
	body: (profile) => profile.prompt,
	setBody: (profile, value) => {
		profile.prompt = value;
	},
	summary: (profile) =>
		profile.prompt.trim() === '' ? 'No prompt' : 'Prompt set',
	visible: (settings) =>
		settings.transcriptionEnabled &&
		settings.transcriptionAutoChaptersEnabled,
};

/** Named rosters of people, suggested when speakers are renamed. */
const SPEAKER_KIND: ProfileKind<SpeakerProfile> = {
	list: SPEAKER_PROFILES,
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
	selectionKey: 'transcriptionSpeakerProfileId',
	bodyKey: 'speakerProfile.participants',
	// The roster is a list of names, and a list of names is a body of one entry
	// per line like any other; it is only stored parsed because a run reads it.
	body: (profile) => profile.participants.join('\n'),
	setBody: (profile, value) => {
		profile.participants = normalizeParticipantNames(value.split(/\r?\n/));
	},
	summary: (profile) =>
		countSummary(profile.participants.length, 'name', 'names'),
	visible: (settings) =>
		settings.transcriptionEnabled && settings.transcriptionDiarize,
};

/**
 * Widens a kind declared over its own profile type to the shared one the
 * settings read. The accessors are the kind's own, so the profile they receive
 * is always of that kind; the cast says so once instead of at every call.
 * @param kind - The kind as its own type declares it
 */
function asProfileKind<T extends Profile>(kind: ProfileKind<T>): ProfileKind {
	return kind as unknown as ProfileKind;
}

/** Every kind of profile, in the order the settings show them. */
export const PROFILE_KINDS: readonly ProfileKind[] = [
	asProfileKind(SPEAKER_KIND),
	asProfileKind(DICTIONARY_KIND),
	asProfileKind(CHAPTER_KIND),
];

/**
 * The kinds whose catalogue belongs to one block of the settings.
 * @param section - The block being built
 * @returns Its kinds, in the order they are shown
 */
export function profileKindsOf(
	section: ProfileSection,
): readonly ProfileKind[] {
	return PROFILE_KINDS.filter((kind) => kind.section === section);
}
