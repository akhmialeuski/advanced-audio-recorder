/**
 * Pure model for a manual speaker rename: the display-level replacement pair
 * the rewriters apply, the dialog's per-speaker entry, the validation that no
 * two speakers resolve to the same display text (merging is unsupported), and
 * the plan builder shared by apply and undo. The plan is self-healing: every
 * rename rule targets both the stored name and the original engine label, so
 * an output that missed an earlier rewrite (failed write, restored file) is
 * corrected by the next apply instead of being orphaned forever. Everything
 * here is side-effect free so it can be unit tested directly.
 * @module speakers/speakerRename
 */

import type { SpeakerEntry } from '../sidecar/recordingSidecarModel';
import {
	emptyNameMap,
	withSpeakerName,
} from '../sidecar/recordingSidecarModel';

/** One display-level rename: the text currently shown and its replacement. */
export interface SpeakerRename {
	/** Display text currently rendered in the existing outputs. */
	from: string;
	/** Display text that should replace it. */
	to: string;
}

/** One dialog row: the speaker label currently shown and the entered name. */
export interface SpeakerNameEntry {
	/** Speaker text as it currently appears in the transcript. */
	label: string;
	/** Name the user entered (empty keeps the original label). */
	name: string;
}

/**
 * The effective display name an entry resolves to once applied: the trimmed
 * typed name, or the original label when the field is left blank (blank keeps
 * the label rather than clearing it).
 */
function effectiveName(entry: SpeakerNameEntry): string {
	return entry.name.trim() || entry.label;
}

/**
 * Returns the display names that two or more distinct speakers would resolve
 * to, which would merge those speakers in every output. Merging is out of
 * scope for now, so the dialog blocks it; an empty result means the entries
 * are safe to apply. A blank field counts as its original label, so assigning
 * one speaker's label as another speaker's name (while leaving the first
 * blank) is still detected. A name equal to any other entry's label is
 * rejected outright - deliberately even for a "swap" where both fields are
 * reassigned: the rewrite itself could swap simultaneously, but the stored
 * roster would then carry names equal to other entries' labels, making the
 * rendered text of two speakers indistinguishable for every later rewrite,
 * re-transcription, and healing pass. Blocking here prevents that ambiguous
 * state from ever being created.
 * @param entries - One entry per detected speaker
 * @returns The offending names, in first-seen order (empty when none)
 */
export function duplicateAssignedNames(
	entries: readonly SpeakerNameEntry[],
): string[] {
	const labelsByName = new Map<string, Set<string>>();
	for (const entry of entries) {
		const name = effectiveName(entry);
		const labels = labelsByName.get(name) ?? new Set<string>();
		labels.add(entry.label);
		labelsByName.set(name, labels);
	}
	const duplicates = new Set<string>();
	for (const [name, labels] of labelsByName) {
		if (labels.size > 1) {
			duplicates.add(name);
		}
	}
	// A name colliding with a different speaker's engine label merges with
	// that label's rendered occurrences even when the other field is filled.
	const labelSet = new Set(entries.map((entry) => entry.label));
	for (const entry of entries) {
		const name = effectiveName(entry);
		if (name !== entry.label && labelSet.has(name)) {
			duplicates.add(name);
		}
	}
	return [...duplicates];
}

/** The full outcome of planning a rename against the stored roster. */
export interface SpeakerRenamePlan {
	/**
	 * Whether the target assignment differs from the stored one. False means
	 * the apply would not change any stored name (nothing to record).
	 */
	changed: boolean;
	/** Display-level replacements to run over the outputs. */
	renames: SpeakerRename[];
	/** The roster to store after the apply, in roster order. */
	nextEntries: SpeakerEntry[];
	/**
	 * Label-to-name assignment after the apply (unnamed labels absent), for
	 * the rename history. Null-prototype, so labels are always plain keys.
	 */
	nextNames: Record<string, string>;
}

/**
 * Plans a rename of the stored roster toward a target assignment: what to
 * store (roster and history mapping) and which display-level replacements to
 * run over the outputs. Each speaker's replacement covers every text it may
 * currently display - the stored name and the original engine label - so an
 * output that missed an earlier rewrite is healed by this one rather than
 * silently skipped forever. Targets are trimmed; an empty or label-equal
 * target reverts the speaker to its engine label.
 *
 * Two entries can claim the same source text (a stale stored name equal to
 * another entry's engine label - a state older sidecars can carry). Such
 * occurrences are textually indistinguishable, so no rule order could
 * rewrite them correctly for both speakers; instead of letting the last
 * rule win nondeterministically, the entry whose engine label IS that text
 * keeps its rule (its claim on its own label is the one the dialog shows)
 * and the stale-name healing rule is dropped.
 * @param roster - The stored speaker roster
 * @param targetFor - Target display name per label ('' reverts to the label)
 */
export function planSpeakerRename(
	roster: readonly SpeakerEntry[],
	targetFor: (label: string) => string,
): SpeakerRenamePlan {
	let changed = false;
	const nextEntries: SpeakerEntry[] = [];
	const nextNames = emptyNameMap();
	/** Rule per source text; ownsLabel marks the label-owner's claim. */
	const byFrom = new Map<string, { to: string; ownsLabel: boolean }>();
	for (const entry of roster) {
		const target = targetFor(entry.label).trim();
		const name = target && target !== entry.label ? target : '';
		// Re-name in place rather than rebuilding the entry, so the first-turn
		// offsets the dialog previews from survive every rename and undo.
		nextEntries.push(withSpeakerName(entry, name));
		if (name) {
			nextNames[entry.label] = name;
		}
		if (name !== (entry.name ?? '')) {
			changed = true;
		}
		const to = name || entry.label;
		// Both the stored name and the engine label may be on display (the
		// label when an earlier rewrite never reached this output); replace
		// whichever is found. The rewriters apply all rules simultaneously,
		// so the extra rule can never chain.
		const candidates = new Set([entry.label, entry.name ?? entry.label]);
		for (const from of candidates) {
			if (from === to) {
				continue;
			}
			const ownsLabel = from === entry.label;
			const existing = byFrom.get(from);
			if (!existing) {
				byFrom.set(from, { to, ownsLabel });
			} else if (!existing.ownsLabel && ownsLabel) {
				existing.to = to;
				existing.ownsLabel = true;
			}
		}
	}
	const renames = [...byFrom].map(([from, rule]) => ({
		from,
		to: rule.to,
	}));
	return { changed, renames, nextEntries, nextNames };
}
