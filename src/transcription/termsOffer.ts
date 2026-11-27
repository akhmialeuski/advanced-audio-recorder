/**
 * The terms a run's note template collected that its dictionary does not
 * hold yet, offered to the dictionary profile the run used.
 *
 * A glossary part collects the names, acronyms and systems said in the
 * recording, which is what the dictionary biases the next recording of the
 * same project with. Left in the note, they are lost, and the engine keeps
 * mangling the same names meeting after meeting. The offer is one action on
 * the notice that reports the run, and there is none when there is nothing
 * to add, so it never becomes another dialog after every meeting.
 * @module transcription/termsOffer
 */

import {
	newDictionaryTerms,
	resolveRunParticipants,
} from '../settings/profileResolution';
import {
	ProfileKindId,
	selectedProfile,
	type Profile,
} from '../settings/profiles';
import type { AudioRecorderSettings } from '../settings/settingsSchema';

/** The terms a run can add, and the dictionary profile they go to. */
export interface TermsOffer {
	/** The dictionary profile the run used. */
	readonly profile: Profile;
	/** The terms it does not hold yet, as the model spelled them. */
	readonly terms: readonly string[];
}

/** An action a notice offers: a button, and what pressing it does. */
export interface NoticeAction {
	readonly label: string;
	readonly run: () => void;
}

/** Builds the notice's action for an offer. */
export type TermsAction = (offer: TermsOffer) => NoticeAction;

/**
 * The terms of a run its dictionary does not hold, or null when there is
 * nothing to offer: no dictionary in use, no glossary part, or every term
 * already in the dictionary. The names of the run's participants are left
 * out too, since a roster already carries them.
 * @param settings - The run's settings, with its profiles' notes read
 * @param terms - The terms the run's glossary parts named
 */
export function termsOfferOf(
	settings: AudioRecorderSettings,
	terms: readonly string[],
): TermsOffer | null {
	const profile = settings.transcriptionAdvancedSettingsEnabled
		? selectedProfile(settings, ProfileKindId.Dictionary)
		: undefined;
	if (!profile || terms.length === 0) {
		return null;
	}
	const people = new Set(
		resolveRunParticipants(settings).map((name) => name.toLowerCase()),
	);
	const fresh = newDictionaryTerms(profile.body, terms).filter(
		(term) => !people.has(term.toLowerCase()),
	);
	return fresh.length === 0 ? null : { profile, terms: fresh };
}
