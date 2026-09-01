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

import { ENGINE_ORDER, ENGINES } from '../providers/providers';
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
	// The only two settings a dropdown edits that are not stored as text; every
	// other numeric setting uses a number control, which speaks numbers.
	bitrate: { numeric: true },
	sampleRate: { numeric: true },
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

/**
 * Largest share of one step a value may miss its grid point by and still count
 * as sitting on it. A grid of tenths cannot be walked in binary floating point
 * - `0.5 + 7 * 0.05` is not `0.85` - so the comparison is made against the
 * nearest grid point rather than by asking whether the quotient is an integer.
 */
const STEP_GRID_TOLERANCE = 1e-6;

/**
 * Why a number is outside what its control accepts, or undefined when it is
 * inside.
 *
 * A number control declares a value space, and the whole of it: the bounds the
 * value lies between and the grid it sits on, which is `min + n * step`. From
 * 1.13 the framework enforces that space itself, refusing anything between two
 * grid points; below it {@link module:settings/legacySettingsRenderer} enforces
 * this, so one declaration means one set of accepted values on both Obsidians
 * rather than two.
 *
 * It follows that a bound no grid point reaches is a declaration that cannot be
 * satisfied - the ceiling of a 512-token grid at 32000 was one - which is why
 * the tree is tested for it rather than left to be discovered as a setting that
 * will not save.
 * @param control - The number control the value was entered into
 * @param value - The number the field produced
 * @returns The reason it is refused, or undefined when it is accepted
 */
export function numberControlRejection(
	control: {
		min?: number | undefined;
		max?: number | undefined;
		/** `'any'` is the input's own way of declaring no grid at all. */
		step?: number | 'any' | undefined;
	},
	value: number,
): string | undefined {
	if (!Number.isFinite(value)) {
		return 'Enter a number.';
	}
	const { min, max, step } = control;
	if (min !== undefined && value < min) {
		return `Enter ${String(min)} or more.`;
	}
	if (max !== undefined && value > max) {
		return `Enter ${String(max)} or less.`;
	}
	if (step === undefined || step === 'any' || step <= 0) {
		return undefined;
	}
	const base = min ?? 0;
	const snapped = base + Math.round((value - base) / step) * step;
	return Math.abs(value - snapped) > step * STEP_GRID_TOLERANCE
		? `Enter a multiple of ${String(step)}${
				min === undefined ? '' : ` above ${String(min)}`
			}.`
		: undefined;
}
