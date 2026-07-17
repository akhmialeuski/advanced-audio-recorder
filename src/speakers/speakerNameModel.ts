/**
 * Speaker-name data model for diarized recordings. A recording remembers
 * the speaker roster its last diarized transcription detected (e.g.
 * "Speaker 1", "Speaker 2") and a mapping from those original labels to
 * user-chosen display names ("Alex"). The roster makes renaming possible
 * even when the transcript went into a note only, and the mapping is what
 * every output format renders instead of the raw labels.
 *
 * Every function here is pure (no DOM, no I/O) so parsing, normalization,
 * and rename-diffing can be unit tested directly.
 * @module speakers/speakerNameModel
 */

/**
 * Speaker naming state for one recording.
 */
export interface SpeakerNames {
	/**
	 * Original speaker labels detected by the last diarized transcription,
	 * in first-seen order.
	 */
	speakers: string[];
	/** Mapping from an original label to its user-chosen display name. */
	names: Record<string, string>;
}

/** Returns a fresh empty speaker-name state. */
export function emptySpeakerNames(): SpeakerNames {
	return { speakers: [], names: {} };
}

/**
 * Returns whether the state carries any data worth persisting. An empty
 * state removes the sidecar instead of leaving an empty file behind.
 * @param value - Speaker-name state
 */
export function hasSpeakerData(value: SpeakerNames): boolean {
	return value.speakers.length > 0 || Object.keys(value.names).length > 0;
}

/**
 * Normalizes speaker-name state for storage: the roster is trimmed and
 * deduplicated (first occurrence wins), and name mappings are trimmed with
 * empty or identity mappings dropped, so the sidecar never stores entries
 * that would render exactly like the original label anyway.
 * @param value - Speaker-name state to normalize
 */
export function serializeSpeakerNames(value: SpeakerNames): SpeakerNames {
	const speakers: string[] = [];
	const seen = new Set<string>();
	for (const label of value.speakers) {
		const trimmed = label.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			speakers.push(trimmed);
		}
	}
	const names: Record<string, string> = {};
	for (const [label, name] of Object.entries(value.names)) {
		const key = label.trim();
		const trimmed = name.trim();
		if (key && trimmed && trimmed !== key) {
			names[key] = trimmed;
		}
	}
	return { speakers, names };
}

/**
 * Parses an unknown value (e.g. JSON from disk) into valid speaker-name
 * state, discarding entries that do not match the expected shape so a
 * corrupt or hand-edited sidecar can never crash the plugin.
 * @param value - Raw parsed value
 */
export function parseSpeakerNames(value: unknown): SpeakerNames {
	if (typeof value !== 'object' || value === null) {
		return emptySpeakerNames();
	}
	const record = value as Record<string, unknown>;
	const speakers = Array.isArray(record.speakers)
		? record.speakers.filter(
				(entry): entry is string => typeof entry === 'string',
			)
		: [];
	const names: Record<string, string> = {};
	if (typeof record.names === 'object' && record.names !== null) {
		for (const [label, name] of Object.entries(record.names)) {
			if (typeof name === 'string') {
				names[label] = name;
			}
		}
	}
	return serializeSpeakerNames({ speakers, names });
}

/**
 * Returns the display name for an original speaker label: the mapped name
 * when one is stored, otherwise the label itself.
 * @param value - Speaker-name state
 * @param label - Original speaker label
 */
export function displaySpeaker(value: SpeakerNames, label: string): string {
	return value.names[label] ?? label;
}

/** One display-level rename: the text currently shown and its replacement. */
export interface SpeakerRename {
	/** Display name currently rendered in existing outputs. */
	from: string;
	/** Display name that should replace it. */
	to: string;
}

/**
 * Diffs two speaker-name states into the display-level renames needed to
 * update outputs already written with the previous names. Compared per
 * roster entry, because outputs render display names, not original labels:
 * a label mapped in neither state renders as itself and yields no rename.
 * @param previous - State the existing outputs were written with
 * @param next - State the outputs should reflect
 */
export function speakerRenames(
	previous: SpeakerNames,
	next: SpeakerNames,
): SpeakerRename[] {
	const renames: SpeakerRename[] = [];
	for (const label of next.speakers) {
		const from = displaySpeaker(previous, label);
		const to = displaySpeaker(next, label);
		if (from !== to) {
			renames.push({ from, to });
		}
	}
	return renames;
}

/**
 * Parses the participant registry setting (one name per line) into a
 * trimmed, deduplicated list, preserving order.
 * @param value - Raw multi-line registry text
 */
export function parseParticipants(value: string): string[] {
	const seen = new Set<string>();
	const participants: string[] = [];
	for (const line of value.split('\n')) {
		const trimmed = line.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			participants.push(trimmed);
		}
	}
	return participants;
}

/**
 * Adds names to the participant registry text, skipping ones already
 * present, so names applied in the rename dialog become suggestions for
 * the next recording. Returns the registry text unchanged when nothing
 * new was added.
 * @param registry - Current multi-line registry text
 * @param names - Names to add
 */
export function addParticipants(
	registry: string,
	names: readonly string[],
): string {
	const existing = parseParticipants(registry);
	const known = new Set(existing);
	const added = [...existing];
	for (const name of names) {
		const trimmed = name.trim();
		if (trimmed && !known.has(trimmed)) {
			known.add(trimmed);
			added.push(trimmed);
		}
	}
	return added.length === existing.length ? registry : added.join('\n');
}
