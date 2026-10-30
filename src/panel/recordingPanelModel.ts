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

import type { QueuedRecording } from '../recording/RecordingSaveQueue';
import { findProfile, type Profile } from '../settings/profiles';
import { formatTimecode } from '../utils/TimeUtils';
import type {
	FailedPartsSection,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';

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

/**
 * A stopped recording in the save queue, named the way a user tells it apart
 * before its file exists: when it started and how long it is.
 * @param recording - The queued recording
 * @returns Its local start time to the minute and its length, such as
 *   `14:05, 1:30 long`
 */
export function formatQueuedRecording(recording: QueuedRecording): string {
	const started = new Date(recording.startedAt).toLocaleTimeString(
		undefined,
		{ timeStyle: 'short' },
	);
	return `${started}, ${formatTimecode(recording.durationSeconds)} long`;
}
