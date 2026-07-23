/**
 * Data model for the per-recording sidecar document (`<recording>.markers.json`).
 * Version 2 holds two independent sections: the player markers (unchanged from
 * version 1) and a `transcript` section that records the speaker roster of the
 * last diarized transcription, the outputs the plugin wrote (with the render
 * templates in effect at write time), and a short history of applied name
 * mappings for undo. Every function here is pure (no I/O) and parsing mirrors
 * the discipline of `markerModel.parseMarkers`: a broken part is dropped while
 * the rest survives, so a hand-edited or corrupt file can never crash a
 * feature or take the other section down with it.
 * @module sidecar/recordingSidecarModel
 */

import {
	parseMarkers,
	serializeMarkers,
	type PlayerMarker,
} from '../markers/markerModel';
import {
	TRANSCRIPT_FILE_FORMATS,
	type TranscriptFileFormat,
} from '../transcription/TranscriptTypes';

/** Current on-disk sidecar schema version. */
const SIDECAR_VERSION = 2;

/** Maximum number of retained rename-history entries (oldest dropped first). */
export const SIDECAR_HISTORY_LIMIT = 10;

/** One diarized speaker: the engine's label and the user-assigned name. */
export interface SpeakerEntry {
	/** Original engine label, e.g. "Speaker 1". */
	label: string;
	/** Display name assigned by the user; absent until renamed. */
	name?: string;
}

/** The in-note render templates a transcript was written with. */
export interface NoteOutputTemplates {
	/** Arrangement of `{timestamp}`, `{speaker}`, and `{text}` per line. */
	lineFormat: string;
	/** Speaker template with a `{speaker}` token. */
	speakerFormat: string;
	/** Whether a timestamp fragment was written on each line. */
	includeTimestamps: boolean;
	/** Whether timestamps were written as timecode links. */
	timestampLinks: boolean;
	/** Whether consecutive same-speaker lines were merged. */
	mergeConsecutiveSpeaker: boolean;
}

/** A note the plugin inserted a rendered transcript into. */
export interface NoteOutput {
	/** Vault path of the note at write time. */
	path: string;
	/** Render templates in effect for that run (per-run overrides included). */
	templates: NoteOutputTemplates;
	/** True when an LLM pass (cleanup/custom) replaced the transcript body. */
	llmProcessed: boolean;
	/** Heading the transcript was inserted under ('' when none). */
	heading: string;
	/** ISO-8601 timestamp of the write. */
	writtenAt: string;
}

/** A transcript sidecar file the plugin wrote next to the recording. */
export interface FileOutput {
	/** Actual vault path written (collision suffixes included). */
	path: string;
	/** Serialization format of the file. */
	format: TranscriptFileFormat;
	/** ISO-8601 timestamp of the write. */
	writtenAt: string;
}

/** Provenance of the last transcription run that wrote outputs. */
export interface TranscriptProvenance {
	/** Detected/declared transcript language (BCP-47 / ISO code), if known. */
	language?: string;
	/** Engine/model identifier that produced the transcript, if known. */
	model?: string;
	/** ISO-8601 timestamp of the run, if known. */
	createdAt?: string;
}

/** One applied name mapping, recorded for undo. */
export interface RenameHistoryEntry {
	/** ISO-8601 timestamp of the apply. */
	at: string;
	/** Full label-to-name assignment after the apply (unnamed labels absent). */
	names: Record<string, string>;
}

/** The transcript section of a recording sidecar. */
export interface TranscriptSection {
	/** Speaker roster of the last diarized transcription, first-seen order. */
	speakers: SpeakerEntry[];
	/** Notes the plugin wrote a transcript into, unique by path. */
	noteOutputs: NoteOutput[];
	/** Transcript files the plugin wrote, unique by path. */
	fileOutputs: FileOutput[];
	/** Applied name mappings, oldest first, capped at the history limit. */
	history: RenameHistoryEntry[];
	/** Provenance of the last run that wrote outputs; absent until recorded. */
	provenance?: TranscriptProvenance;
}

/** The full parsed sidecar document for one recording. */
export interface RecordingSidecar {
	markers: PlayerMarker[];
	transcript: TranscriptSection;
}

/** Returns a fresh, empty transcript section. */
export function emptyTranscriptSection(): TranscriptSection {
	return { speakers: [], noteOutputs: [], fileOutputs: [], history: [] };
}

/** Returns a fresh, fully empty sidecar document. */
export function emptyRecordingSidecar(): RecordingSidecar {
	return { markers: [], transcript: emptyTranscriptSection() };
}

/**
 * Whether a transcript section carries no data worth keeping. Provenance is
 * deliberately not counted: it only describes the run behind the section's
 * substantive lists, so once those are empty there is nothing left for it to
 * describe - counting it would keep an otherwise-empty sidecar file on disk
 * forever after any transcription.
 */
export function isTranscriptSectionEmpty(section: TranscriptSection): boolean {
	return (
		section.speakers.length === 0 &&
		section.noteOutputs.length === 0 &&
		section.fileOutputs.length === 0 &&
		section.history.length === 0
	);
}

/**
 * Whether a sidecar document holds nothing worth persisting: no markers and
 * an empty transcript section. Only then may the file be deleted.
 * @param sidecar - Parsed sidecar document
 */
export function isSidecarEmpty(sidecar: RecordingSidecar): boolean {
	return (
		sidecar.markers.length === 0 &&
		isTranscriptSectionEmpty(sidecar.transcript)
	);
}

/** Reads a string field, trimmed, or null when absent/not a string/empty. */
function trimmedString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses the speaker roster: non-object entries and entries without a usable
 * label are dropped, names equal to their label are omitted, and a duplicated
 * label keeps its first entry.
 */
function parseSpeakers(value: unknown): SpeakerEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const result: SpeakerEntry[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const label = trimmedString(record.label);
		if (!label || seen.has(label)) {
			continue;
		}
		seen.add(label);
		const name = trimmedString(record.name);
		result.push(name && name !== label ? { label, name } : { label });
	}
	return result;
}

/** Parses one note output's templates, or null when not template-shaped. */
function parseTemplates(value: unknown): NoteOutputTemplates | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const lineFormat = record.lineFormat;
	const speakerFormat = record.speakerFormat;
	if (typeof lineFormat !== 'string' || typeof speakerFormat !== 'string') {
		return null;
	}
	// Booleans the plugin always writes; a hand-edited or missing flag falls
	// back to the shipped defaults rather than invalidating the whole entry.
	return {
		lineFormat,
		speakerFormat,
		includeTimestamps:
			typeof record.includeTimestamps === 'boolean'
				? record.includeTimestamps
				: true,
		timestampLinks:
			typeof record.timestampLinks === 'boolean'
				? record.timestampLinks
				: true,
		mergeConsecutiveSpeaker:
			typeof record.mergeConsecutiveSpeaker === 'boolean'
				? record.mergeConsecutiveSpeaker
				: true,
	};
}

/** Parses the note outputs list; a duplicated path keeps its first entry. */
function parseNoteOutputs(value: unknown): NoteOutput[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const result: NoteOutput[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const path = trimmedString(record.path);
		const templates = parseTemplates(record.templates);
		if (!path || !templates || seen.has(path)) {
			continue;
		}
		seen.add(path);
		result.push({
			path,
			templates,
			llmProcessed: record.llmProcessed === true,
			heading: typeof record.heading === 'string' ? record.heading : '',
			writtenAt:
				typeof record.writtenAt === 'string' ? record.writtenAt : '',
		});
	}
	return result;
}

/** Parses the file outputs list; a duplicated path keeps its first entry. */
function parseFileOutputs(value: unknown): FileOutput[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const result: FileOutput[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const path = trimmedString(record.path);
		const format = record.format;
		if (
			!path ||
			seen.has(path) ||
			!TRANSCRIPT_FILE_FORMATS.includes(format as TranscriptFileFormat)
		) {
			continue;
		}
		seen.add(path);
		result.push({
			path,
			format: format as TranscriptFileFormat,
			writtenAt:
				typeof record.writtenAt === 'string' ? record.writtenAt : '',
		});
	}
	return result;
}

/** Parses the rename history, keeping only the newest entries at the cap. */
function parseHistory(value: unknown): RenameHistoryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: RenameHistoryEntry[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const names = record.names;
		if (typeof names !== 'object' || names === null) {
			continue;
		}
		// A null-prototype object keeps hostile labels ("__proto__",
		// "constructor") plain data keys instead of touching the prototype.
		const mapping: Record<string, string> = emptyNameMap();
		for (const [label, name] of Object.entries(names)) {
			if (typeof name === 'string') {
				mapping[label] = name;
			}
		}
		result.push({
			at: typeof record.at === 'string' ? record.at : '',
			names: mapping,
		});
	}
	return result.slice(-SIDECAR_HISTORY_LIMIT);
}

/**
 * Parses the transcript section of a sidecar document. A missing or
 * non-object section yields an empty one; each list inside is normalized
 * independently so one broken part never discards the others.
 */
export function parseTranscriptSection(value: unknown): TranscriptSection {
	if (typeof value !== 'object' || value === null) {
		return emptyTranscriptSection();
	}
	const record = value as Record<string, unknown>;
	const provenance = parseProvenance(record.provenance);
	return {
		speakers: parseSpeakers(record.speakers),
		noteOutputs: parseNoteOutputs(record.noteOutputs),
		fileOutputs: parseFileOutputs(record.fileOutputs),
		history: parseHistory(record.history),
		...(provenance ? { provenance } : {}),
	};
}

/** Parses the run provenance, or null when absent or not object-shaped. */
function parseProvenance(value: unknown): TranscriptProvenance | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const provenance: TranscriptProvenance = {};
	const language = trimmedString(record.language);
	const model = trimmedString(record.model);
	const createdAt = trimmedString(record.createdAt);
	if (language) {
		provenance.language = language;
	}
	if (model) {
		provenance.model = model;
	}
	if (createdAt) {
		provenance.createdAt = createdAt;
	}
	return Object.keys(provenance).length > 0 ? provenance : null;
}

/**
 * Returns a null-prototype label-to-name map, so speaker labels can never
 * collide with inherited Object.prototype members.
 */
export function emptyNameMap(): Record<string, string> {
	return Object.create(null) as Record<string, string>;
}

/**
 * Returns a deep copy of a transcript section, so callers can hold a stable
 * snapshot while the store keeps mutating its cached document.
 * @param section - Section to clone
 */
export function cloneTranscriptSection(
	section: TranscriptSection,
): TranscriptSection {
	return {
		speakers: section.speakers.map((entry) =>
			entry.name
				? { label: entry.label, name: entry.name }
				: { label: entry.label },
		),
		noteOutputs: section.noteOutputs.map((output) => ({
			...output,
			templates: { ...output.templates },
		})),
		fileOutputs: section.fileOutputs.map((output) => ({ ...output })),
		history: section.history.map((entry) => ({
			at: entry.at,
			names: Object.assign(emptyNameMap(), entry.names),
		})),
		...(section.provenance
			? { provenance: { ...section.provenance } }
			: {}),
	};
}

/**
 * Parses an unknown value (JSON from disk) into a sidecar document. A
 * version-1 file contributes its markers and an empty transcript section; an
 * unrecognizable value yields a fully empty document. Markers and the
 * transcript section are parsed independently, so corruption in one never
 * loses the other.
 * @param value - Raw parsed JSON value
 */
export function parseRecordingSidecar(value: unknown): RecordingSidecar {
	if (typeof value !== 'object' || value === null) {
		return emptyRecordingSidecar();
	}
	const record = value as Record<string, unknown>;
	return {
		markers: parseMarkers(record.markers),
		transcript: parseTranscriptSection(record.transcript),
	};
}

/**
 * Serializes a sidecar document for storage as version 2. The transcript key
 * is omitted while its section is empty, so a markers-only sidecar stays as
 * small as before this section existed.
 * @param sidecar - Document to serialize
 */
export function serializeRecordingSidecar(
	sidecar: RecordingSidecar,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		version: SIDECAR_VERSION,
		markers: serializeMarkers(sidecar.markers),
	};
	if (!isTranscriptSectionEmpty(sidecar.transcript)) {
		payload.transcript = {
			speakers: sidecar.transcript.speakers.map((entry) =>
				entry.name
					? { label: entry.label, name: entry.name }
					: { label: entry.label },
			),
			noteOutputs: sidecar.transcript.noteOutputs.map((output) => ({
				path: output.path,
				templates: { ...output.templates },
				llmProcessed: output.llmProcessed,
				heading: output.heading,
				writtenAt: output.writtenAt,
			})),
			fileOutputs: sidecar.transcript.fileOutputs.map((output) => ({
				path: output.path,
				format: output.format,
				writtenAt: output.writtenAt,
			})),
			history: sidecar.transcript.history.map((entry) => ({
				at: entry.at,
				names: { ...entry.names },
			})),
			...(sidecar.transcript.provenance
				? { provenance: { ...sidecar.transcript.provenance } }
				: {}),
		};
	}
	return payload;
}
