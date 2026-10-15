/**
 * Reading and writing the value behind a control key.
 *
 * A row of the tree names a control key, and most keys are settings properties
 * the framework can read and write directly. The rest address an entry of a
 * list, carry a value the stored one has to be derived from, or need a second
 * effect once written, and this module is where those keys are answered. It is
 * separate from the tree because it is a different question: the tree says what
 * a row is, this says what its value means.
 * @module settings/controlValues
 */

import { ACCOUNTS, ENGINE_ORDER, ENGINES } from '../providers/providers';
import { PROFILE_KINDS } from './profileKinds';

/**
 * What writing a control means beyond storing its value.
 *
 * A `visible` predicate covers a setting that reveals another one, which is
 * most of them. It cannot cover the rest of what a write can mean: a value the
 * plugin stores in a form of its own, or a choice that leaves the same rows on
 * screen holding different things. Both live here, next to the declarations
 * they belong to, rather than as branches in the tab's write path.
 */
export interface ControlWriteEffect {
	/** Rewrites the value before it is stored. */
	readonly normalize?: (value: string) => string;
	/**
	 * Whether the setting holds a number while the control bound to it speaks
	 * strings, which is the case for the two dropdowns that pick one. Both
	 * directions convert: without it the string a dropdown hands back would be
	 * stored where the schema declares a number - past the type system, since a
	 * control key addresses the settings object dynamically - and the number
	 * read back would match no option, leaving the dropdown blank.
	 */
	readonly numeric?: boolean;
	/**
	 * Whether the write changes what other rows *show*, not merely whether they
	 * show. Picking another engine swaps the model catalogue and the credential
	 * fields; picking another profile repoints the editor below it. The rows
	 * are the same rows with different contents, which no predicate expresses,
	 * so the tree is read again.
	 */
	readonly reshapesTree?: boolean;
}

/** The writes that mean more than "store this". Keyed by control key. */
export const CONTROL_WRITE_EFFECTS: Readonly<
	Record<string, ControlWriteEffect>
> = {
	transcriptionLanguage: {
		// Stored as the engines receive it: " en " is the same language as
		// "en", and an untrimmed code reaches the request verbatim.
		normalize: (value) => value.trim(),
	},
	// The one setting a dropdown edits that is not stored as text. Every other
	// numeric setting uses a number control, which speaks numbers, and the
	// bitrate row went imperative once its options started depending on the
	// format and the rate.
	sampleRate: { numeric: true },
	// The channel layout a recording will have is settled by these three
	// between them: the layout a single capture is reduced to, the per-track
	// configuration that replaces it, and the system output paired with the
	// microphone, which is captured in stereo whatever the microphone is. Two
	// rows of the Output format section are built from that layout rather than
	// from a key of their own - an encoder accepts its own set of bitrates per
	// layout, and answers per layout whether it can write a format at all - so
	// they keep the previous answer until the tree is read again.
	recordingChannels: { reshapesTree: true },
	// The output summary names the width a WAV recording is written at, so
	// moving the width leaves that line saying something else.
	recordingBitDepth: { reshapesTree: true },
	enableMultiTrack: { reshapesTree: true },
	includeSystemAudio: { reshapesTree: true },
	// The track count decides which tracks that layout is taken from, and the
	// output mode decides whether a track placed off centre takes the combined
	// file to stereo, so both move the same answer. The per-track rows move it
	// too and are answered in the tab's own write path, which reaches them
	// before this table.
	maxTracks: { reshapesTree: true },
	outputMode: { reshapesTree: true },
	// Picking another transcription engine rewrites the descriptions the
	// speaker rows carry, which are built from the engine rather than
	// re-evaluated per pass. The three rows that pick an engine for an LLM job
	// need no entry: every service is configured on its own page now, so
	// nothing under such a row holds the chosen vendor's fields.
	transcriptionProvider: { reshapesTree: true },
	// The prompt catalogue under the task row is the catalogue of the task in
	// hand, so picking another task replaces the rows below it.
	llmPostProcessTask: { reshapesTree: true },
	// Every catalogue names the profile in use on the entry that opens it, so
	// moving that selection leaves those rows holding something else. Read from
	// the kinds themselves, so a kind added there arrives with this behaviour
	// instead of silently missing it.
	...Object.fromEntries(
		PROFILE_KINDS.map((kind) => [
			kind.selectionKey,
			{ reshapesTree: true },
		]),
	),
	// An engine's entry reports the model it runs on, and its catalogue marks
	// that id as the one in use, so picking another leaves both holding
	// something else. Read from the registry, so an engine added there arrives
	// with this behaviour rather than silently missing it.
	...Object.fromEntries(
		ENGINE_ORDER.flatMap((id) => {
			const models = ENGINES[id].models;
			return models ? [[models.modelKey, { reshapesTree: true }]] : [];
		}),
	),
	// Linking a keychain secret is what gives an account its key, and every
	// engine over the account reports on its entry whether it has one, as the
	// Engines page does in its count. Those are values the framework only
	// reads again on update(), so the tree is read again.
	...Object.fromEntries(
		Object.values(ACCOUNTS).map((account) => [
			account.apiKeySecretKey,
			{ reshapesTree: true },
		]),
	),
};

/**
 * Projects a stored value into what its control speaks, and back. The two
 * halves sit together so a conversion cannot be applied in one direction only.
 */
export const controlValue = {
	/**
	 * The stored value as the control reads it.
	 * @param key - The settings key the control is bound to
	 * @param stored - The stored value
	 */
	read(key: string, stored: unknown): unknown {
		return CONTROL_WRITE_EFFECTS[key]?.numeric ? String(stored) : stored;
	},
	/**
	 * The control's value as the setting stores it. A field left empty or
	 * holding something unparseable keeps the stored value rather than writing
	 * NaN into it.
	 * @param key - The settings key the control is bound to
	 * @param value - The value the control produced
	 * @param stored - What the setting holds now
	 */
	write(key: string, value: unknown, stored: unknown): unknown {
		const effect = CONTROL_WRITE_EFFECTS[key];
		if (effect?.numeric) {
			// An empty field reads as 0 through Number(), which is a value no
			// numeric setting here can take, so it counts as unparseable.
			const empty = typeof value === 'string' && value.trim() === '';
			const parsed = Number(value);
			return !empty && Number.isFinite(parsed) ? parsed : stored;
		}
		return effect?.normalize && typeof value === 'string'
			? effect.normalize(value)
			: value;
	},
};
