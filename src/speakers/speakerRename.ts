/**
 * Pure model for a manual speaker rename: the display-level replacement pair
 * the rewriters apply, the dialog's per-speaker entry, the validation that no
 * speaker is named after another speaker's engine label, the merges an apply
 * would create (two diarized labels that are really one person, given one
 * name), and the plan builder shared by apply and undo. The plan is
 * self-healing: every rename rule targets both the stored name and the
 * original engine label, so an output that missed an earlier rewrite (failed
 * write, restored file) is corrected by the next apply instead of being
 * orphaned forever. Everything here is side-effect free so it can be unit
 * tested directly.
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

/** Two or more diarized labels sharing one name, i.e. one merged speaker. */
export interface SpeakerMerge {
	/** The shared display name. */
	name: string;
	/** Engine labels resolving to it, in roster order. */
	labels: string[];
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
 * Returns the names that would collide with a *different* speaker's engine
 * label, which the dialog refuses. Deliberately rejected even for a "swap"
 * where both fields are reassigned: the rewrite itself could swap
 * simultaneously, but the stored roster would then carry a name equal to
 * another entry's label, and every later rewrite, re-transcription, and
 * healing pass would have to guess which speaker an occurrence of that text
 * belongs to. Blocking here prevents that ambiguous state from ever being
 * created. A blank field counts as its original label, so naming one speaker
 * after another whose field is left blank is caught too.
 *
 * Note what this does *not* reject: two speakers given the same real name.
 * That is a deliberate merge (diarization routinely splits one person into
 * two labels) and is supported - see {@link speakerMerges}.
 * @param entries - One entry per detected speaker
 * @returns The offending names, in first-seen order (empty when none)
 */
export function labelCollisionNames(
	entries: readonly SpeakerNameEntry[],
): string[] {
	const labels = new Set(entries.map((entry) => entry.label));
	const collisions = new Set<string>();
	for (const entry of entries) {
		const name = effectiveName(entry);
		if (name !== entry.label && labels.has(name)) {
			collisions.add(name);
		}
	}
	return [...collisions];
}

/**
 * Groups the entries by the name they resolve to and returns the groups
 * holding more than one label: the speakers this assignment merges into one
 * person. What the dialog confirms before applying and names afterwards,
 * since a merge is what the outputs cannot be talked out of afterwards - once
 * two speakers render as the same text, nothing can tell their lines apart
 * again.
 * @param entries - One entry per detected speaker
 * @returns One group per merged name, in first-seen order
 */
export function speakerMerges(
	entries: readonly SpeakerNameEntry[],
): SpeakerMerge[] {
	const byName = new Map<string, string[]>();
	for (const entry of entries) {
		const name = effectiveName(entry);
		const labels = byName.get(name) ?? [];
		labels.push(entry.label);
		byName.set(name, labels);
	}
	return [...byName]
		.filter(([, labels]) => labels.length > 1)
		.map(([name, labels]) => ({ name, labels }));
}

/**
 * The merges an apply would newly create, i.e. the ones the stored roster does
 * not already hold these speakers in. A merge already applied is re-applied on
 * every repeat (the healing rules see to that) and must not ask the user to
 * confirm it again; only labels not already merged together are a fresh
 * irreversible step.
 *
 * Groups are matched by their labels and not by their name, because the name
 * is what a later apply is free to change: renaming an already-merged pair
 * from "Alex" to "Alexander" merges nobody, while adding a third label to that
 * pair does.
 * @param stored - Merges the stored roster already carries
 * @param target - Merges the entered assignment would produce
 * @returns The target merges that are new or widened, in target order
 */
export function addedMerges(
	stored: readonly SpeakerMerge[],
	target: readonly SpeakerMerge[],
): SpeakerMerge[] {
	const storedGroups = stored.map((merge) => new Set(merge.labels));
	return target.filter(
		(merge) =>
			!storedGroups.some((group) =>
				merge.labels.every((label) => group.has(label)),
			),
	);
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
	/**
	 * Display texts the outputs must keep as they are, because more than one
	 * speaker currently renders as that text and they no longer resolve to the
	 * same name - the state a merge leaves behind, which splitting the roster
	 * again cannot undo in text already written. Reported so the dialog can
	 * say what was left alone instead of silently dragging both speakers'
	 * lines to whichever rule happened to win.
	 */
	ambiguous: string[];
	/** The roster to store after the apply, in roster order. */
	nextEntries: SpeakerEntry[];
	/**
	 * Label-to-name assignment after the apply (unnamed labels absent), for
	 * the rename history. Null-prototype, so labels are always plain keys.
	 */
	nextNames: Record<string, string>;
}

/**
 * Whether a plan has anything at all to do, over both of the places a rename
 * reaches: a roster assignment to store, or a replacement to run over the
 * outputs. The two are independent, and only the second survives a repeat -
 * once the roster holds the names, `changed` is false while the healing rules
 * that reach an output still showing an engine label remain. Gating an apply
 * on `changed` alone is therefore what strands such an output forever.
 * @param plan - Plan built by `planSpeakerRename`
 * @returns True when applying the plan could still change something
 */
export function planHasWork(plan: SpeakerRenamePlan): boolean {
	return plan.changed || plan.renames.length > 0;
}

/**
 * What the speakers seen so far want done with one source text.
 *
 * A speaker whose own engine label IS that text settles it: its claim is the
 * one the dialog shows, and the alternative is letting rule order decide.
 * Every other claimant is a speaker that merely renders as that text right
 * now, and the rewrite can only go ahead when they all want the same result -
 * which is the case for a merge being applied or re-applied.
 */
interface RenameRule {
	/** Display name the claim currently in force resolves to. */
	to: string;
	/** Whether that claim came from the speaker whose label this text is. */
	ownsLabel: boolean;
	/** Whether every claim so far agrees on `to`. */
	agreed: boolean;
}

/**
 * Plans a rename of the stored roster toward a target assignment: what to
 * store (roster and history mapping) and which display-level replacements to
 * run over the outputs. Each speaker's replacement covers every text it may
 * currently display - the stored name and the original engine label - so an
 * output that missed an earlier rewrite is healed by this one rather than
 * silently skipped forever. Targets are trimmed; an empty or label-equal
 * target reverts the speaker to its engine label. Several speakers may share
 * one target, which is how a person diarization split into two labels is
 * merged back together.
 *
 * Two entries can claim the same source text: two merged speakers both
 * rendering as the shared name, or a stale stored name equal to another
 * entry's engine label (a state older sidecars can carry). Such occurrences
 * are textually indistinguishable, so a text is rewritten only where every
 * claimant agrees (or the label's owner settles it, see {@link RenameRule})
 * and the rest are reported as `ambiguous` rather than letting the last rule
 * win.
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
	/** The rule per source text, narrowed by each claim, in first-seen order. */
	const byFrom = new Map<string, RenameRule>();
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
		// so the extra rule can never chain. A claim that changes nothing is
		// recorded too: it is what tells a shared name apart from one only
		// this speaker renders as.
		const candidates = new Set([entry.label, entry.name ?? entry.label]);
		for (const from of candidates) {
			const ownsLabel = from === entry.label;
			const existing = byFrom.get(from);
			if (!existing) {
				byFrom.set(from, { to, ownsLabel, agreed: true });
				continue;
			}
			// The label's owner has spoken, whichever order the roster put
			// the two in: a stale name claiming the same text neither
			// overrides that nor makes the text ambiguous, and an owner
			// arriving late settles a text two stale claims disagreed on.
			if (existing.ownsLabel) {
				continue;
			}
			if (ownsLabel) {
				existing.to = to;
				existing.ownsLabel = true;
				existing.agreed = true;
				continue;
			}
			if (existing.to !== to) {
				existing.agreed = false;
			}
		}
	}
	const renames: SpeakerRename[] = [];
	const ambiguous: string[] = [];
	for (const [from, rule] of byFrom) {
		if (!rule.agreed) {
			ambiguous.push(from);
		} else if (from !== rule.to) {
			renames.push({ from, to: rule.to });
		}
	}
	return { changed, renames, ambiguous, nextEntries, nextNames };
}
