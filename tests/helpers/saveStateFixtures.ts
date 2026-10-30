/**
 * What the save queue reports while it saves stopped recordings, for the
 * suites that drive the surfaces showing it. Each queued recording carries
 * its own start and length, so a suite builds the whole state from a count
 * of waiting saves instead of spelling out every entry.
 * @module tests/helpers/saveStateFixtures
 */

import type {
	QueuedRecording,
	RecordingSaveState,
} from 'src/recording/RecordingSaveQueue';
import { RecordingStatus, type SaveProgress } from 'src/types';

/** The state of a queue with nothing to save, for suites that also build busy ones here. */
export { IDLE_SAVE_STATE } from 'src/recording/RecordingSaveQueue';

/** When the first queued recording started: 2026-10-30 14:05 UTC. */
const FIRST_QUEUED_START = Date.UTC(2026, 9, 30, 14, 5);

/** How far apart the queued recordings started. */
const QUEUED_START_STEP_MS = 10 * 60 * 1000;

/**
 * The recording at a place in the queue: each one started ten minutes after
 * the one before it and lasts one minute longer, so no two read alike.
 * @param place - Its place, 0 for the one being saved
 * @returns The recording
 */
function queuedRecording(place: number): QueuedRecording {
	return {
		startedAt: FIRST_QUEUED_START + place * QUEUED_START_STEP_MS,
		durationSeconds: 60 * (place + 1),
	};
}

/** What a save state is built from. */
interface SaveStateOptions {
	/** Saving or Interrupted, by why the running capture ended. */
	readonly status?: RecordingStatus;
	/** Progress of the running save, once it has reported any. */
	readonly progress?: SaveProgress | undefined;
	/** How many saves wait behind the running one. */
	readonly waiting?: number;
}

/**
 * The queue while it saves one recording, with others waiting behind it.
 * @param options - What differs from a save with no progress and nothing
 *   waiting
 * @returns The state the queue reports
 */
export function savingState(
	options: SaveStateOptions = {},
): RecordingSaveState {
	return {
		status: options.status ?? RecordingStatus.Saving,
		progress: options.progress,
		saving: queuedRecording(0),
		waiting: Array.from({ length: options.waiting ?? 0 }, (_, index) =>
			queuedRecording(index + 1),
		),
	};
}
