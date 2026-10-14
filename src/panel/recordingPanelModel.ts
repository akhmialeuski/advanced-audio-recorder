/**
 * What the recording panel says about one recording, worked out from the
 * recording's sidecar and the settings without touching the DOM or the vault.
 *
 * The panel is a reader, not an editor: everything it shows is already stored
 * somewhere - the speaker roster and the participants in the transcript
 * section, the template a transcript was written with in its note outputs, the
 * chapters and bookmarks in the markers - and this module only gathers those
 * pieces into one summary, so the view stays a renderer and the rules about
 * what counts are testable without one.
 * @module panel/recordingPanelModel
 */

import { getLinkpath } from 'obsidian';
import type { CachedMetadata, TFile } from 'obsidian';
import { MARKER_KIND, type PlayerMarker } from '../markers/markerModel';
import { findProfile, type Profile } from '../settings/profiles';
import type {
	FailedPartsSection,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import { isAudioFile } from '../utils/audioFile';

/** One speaker as the panel lists it. */
export interface PanelSpeaker {
	/** The engine's label, e.g. "Speaker 1". */
	label: string;
	/** The name the user assigned, or null while the speaker is unnamed. */
	name: string | null;
}

/** A transcript file written next to the recording. */
export interface PanelFileOutput {
	/** Vault path of the file. */
	path: string;
	/** Its serialization format, upper-cased for display ("SRT"). */
	format: string;
	/** The language it was translated into, or null for the original. */
	language: string | null;
}

/** Everything the panel shows about a recording beyond the file itself. */
export interface RecordingPanelSummary {
	/** Speakers of the last diarized transcript, first-seen order. */
	speakers: PanelSpeaker[];
	/** Participant names the recording carries. */
	participants: string[];
	/** Name of the participants profile the names came from, if it still exists. */
	participantProfile: string | null;
	/** Language of the last transcript, if known. */
	language: string | null;
	/** Engine or model that produced the last transcript, if known. */
	model: string | null;
	/** ISO-8601 timestamp of the last transcription, if known. */
	transcribedAt: string | null;
	/**
	 * The line template the transcript was written with: the one used for the
	 * note being looked at when the transcript went there, else the latest
	 * write. Null when the plugin never wrote this recording into a note.
	 */
	lineTemplate: string | null;
	/** Notes the plugin wrote a transcript into. */
	noteOutputs: string[];
	/** Transcript files the plugin wrote. */
	fileOutputs: PanelFileOutput[];
	/** How many chapter markers the recording has. */
	chapters: number;
	/** How many bookmarks the recording has. */
	bookmarks: number;
	/** How many parts the last run could not transcribe. */
	failedParts: number;
}

/** What {@link summarizeRecording} reads. */
export interface RecordingPanelSources {
	/** The transcript section of the recording's sidecar. */
	transcript: TranscriptSection;
	/** The recording's markers. */
	markers: readonly PlayerMarker[];
	/** The parts the last run lost, or null when it came back whole. */
	failedParts: FailedPartsSection | null;
	/** Every stored profile, to name the participants profile by. */
	profiles: readonly Profile[];
	/** The note being looked at, or '' when the recording itself is open. */
	notePath: string;
}

/**
 * Gathers what the panel shows about one recording.
 * @param sources - The recording's stored data and the context it is viewed in
 * @returns The summary the panel renders
 */
export function summarizeRecording(
	sources: RecordingPanelSources,
): RecordingPanelSummary {
	const { transcript, markers, failedParts, profiles, notePath } = sources;
	const profileId = transcript.participantProfileId ?? '';
	return {
		speakers: transcript.speakers.map((speaker) => ({
			label: speaker.label,
			name: speaker.name ?? null,
		})),
		participants: [...transcript.participants],
		participantProfile:
			profileId === ''
				? null
				: (findProfile(profiles, profileId)?.name ?? null),
		language: transcript.provenance?.language ?? null,
		model: transcript.provenance?.model ?? null,
		transcribedAt: transcript.provenance?.createdAt ?? null,
		lineTemplate: lineTemplateFor(transcript, notePath),
		noteOutputs: transcript.noteOutputs.map((output) => output.path),
		fileOutputs: transcript.fileOutputs.map((output) => ({
			path: output.path,
			format: output.format.toUpperCase(),
			language: output.language ?? null,
		})),
		chapters: markers.filter((m) => m.kind === MARKER_KIND.chapter).length,
		bookmarks: markers.filter((m) => m.kind === MARKER_KIND.bookmark)
			.length,
		failedParts: failedParts?.parts.length ?? 0,
	};
}

/**
 * The line template a transcript was written with, preferring the note in
 * view: one recording can be transcribed into several notes, each with the
 * templates in effect at the time, and the one the reader is looking at is
 * the one whose lines they see.
 * @param transcript - The recording's transcript section
 * @param notePath - The note in view, or '' for none
 * @returns The line template, or null when no note output is recorded
 */
function lineTemplateFor(
	transcript: TranscriptSection,
	notePath: string,
): string | null {
	const inView = transcript.noteOutputs.find(
		(output) => output.path === notePath,
	);
	if (inView) {
		return inView.templates.lineFormat;
	}
	const latest = [...transcript.noteOutputs].sort((a, b) =>
		b.writtenAt.localeCompare(a.writtenAt),
	)[0];
	return latest?.templates.lineFormat ?? null;
}

/**
 * The recordings a note embeds or links to, embeds first and each once.
 *
 * A meeting note usually embeds its recording, but a note that only links to
 * it is about the same meeting, so both count. The metadata cache already
 * holds the note's parsed links, so nothing is read from disk here.
 * @param cache - The note's cached metadata, or null when not parsed yet
 * @param resolve - Resolves a link text to the file it points at
 * @returns The audio files the note refers to, in the order they appear
 */
export function recordingsReferencedBy(
	cache: CachedMetadata | null,
	resolve: (link: string) => TFile | null,
): TFile[] {
	const links = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
	// A transcript links every line into the same recording, so each target
	// is resolved once rather than once per line.
	const targets = new Set(
		// Without the `#t=` subpath a timecode link carries, which the
		// resolver does not accept.
		links.map(({ link }) => getLinkpath(link)),
	);
	const seen = new Set<string>();
	const recordings: TFile[] = [];
	for (const target of targets) {
		const file = resolve(target);
		if (!file || !isAudioFile(file) || seen.has(file.path)) {
			continue;
		}
		seen.add(file.path);
		recordings.push(file);
	}
	return recordings;
}

/**
 * A stored timestamp as the panel prints it, or the raw text when it does not
 * parse - a hand-edited sidecar is still shown rather than hidden.
 * @param iso - ISO-8601 timestamp
 * @returns Local date and time
 */
export function formatPanelDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
