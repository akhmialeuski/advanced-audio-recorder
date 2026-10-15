/**
 * What the recording panel says about one recording, worked out from the
 * recording's sidecar and the settings without touching the DOM or the vault.
 *
 * The panel is a reader, not an editor: everything it shows is already stored
 * somewhere - the participant names and the speaker roster in the transcript
 * section, how and when the recording was transcribed in its provenance - and
 * this module only gathers those pieces into one summary, so the view stays a
 * renderer and the rules about what counts are testable without one.
 * @module panel/recordingPanelModel
 */

import { getLinkpath } from 'obsidian';
import type { CachedMetadata, TFile } from 'obsidian';
import { findProfile, type Profile } from '../settings/profiles';
import type {
	FailedPartsSection,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import { isAudioFile } from '../utils/audioFile';

/** One person who took part in the recording, as the panel lists them. */
export interface PanelParticipant {
	/** The person's name. */
	name: string;
	/** The speaker label the user gave this name to, or null for none. */
	speaker: string | null;
}

/** Everything the panel shows about a recording beyond the file itself. */
export interface RecordingPanelSummary {
	/**
	 * Who took part: the participant names in their stored order, then any
	 * name the user gave a speaker that is not among them. A speaker nobody
	 * named is not a person yet, so it is not listed.
	 */
	participants: PanelParticipant[];
	/** Name of the participants profile the names came from, if it still exists. */
	participantProfile: string | null;
	/** Engine or model that produced the last transcript, if known. */
	model: string | null;
	/** Language of the last transcript, if known. */
	language: string | null;
	/** ISO-8601 timestamp of the last transcription, if known. */
	transcribedAt: string | null;
	/** How many parts the last run could not transcribe. */
	failedParts: number;
}

/** What {@link summarizeRecording} reads. */
export interface RecordingPanelSources {
	/** The transcript section of the recording's sidecar. */
	transcript: TranscriptSection;
	/** The parts the last run lost, or null when it came back whole. */
	failedParts: FailedPartsSection | null;
	/** Every stored profile, to name the participants profile by. */
	profiles: readonly Profile[];
}

/**
 * Gathers what the panel shows about one recording.
 * @param sources - The recording's stored data and the stored profiles
 * @returns The summary the panel renders
 */
export function summarizeRecording(
	sources: RecordingPanelSources,
): RecordingPanelSummary {
	const { transcript, failedParts, profiles } = sources;
	const profileId = transcript.participantProfileId ?? '';
	return {
		participants: participantsOf(transcript),
		participantProfile:
			profileId === ''
				? null
				: (findProfile(profiles, profileId)?.name ?? null),
		model: transcript.provenance?.model ?? null,
		language: transcript.provenance?.language ?? null,
		transcribedAt: transcript.provenance?.createdAt ?? null,
		failedParts: failedParts?.parts.length ?? 0,
	};
}

/**
 * The people of a recording, each with the speaker label given their name.
 * @param transcript - The recording's transcript section
 * @returns The participant names first, then names given only to a speaker
 */
function participantsOf(transcript: TranscriptSection): PanelParticipant[] {
	const speakerOf = new Map<string, string>();
	for (const { label, name } of transcript.speakers) {
		if (name && !speakerOf.has(name)) {
			speakerOf.set(name, label);
		}
	}
	const names = [...transcript.participants];
	for (const name of speakerOf.keys()) {
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	return names.map((name) => ({
		name,
		speaker: speakerOf.get(name) ?? null,
	}));
}

/**
 * The recordings a note embeds or links to, in its body or its properties,
 * embeds first and each once.
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
	const links = [
		...(cache?.embeds ?? []),
		...(cache?.links ?? []),
		// A property such as `recording: "[[standup.webm]]"`.
		...(cache?.frontmatterLinks ?? []),
	];
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
 * @returns Local date and time to the minute, the way the panel's rows fit it
 */
export function formatPanelDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? iso
		: date.toLocaleString(undefined, {
				dateStyle: 'short',
				timeStyle: 'short',
			});
}
