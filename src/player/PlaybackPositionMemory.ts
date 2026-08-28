/**
 * Remembers where a recording was left off, so reopening it resumes instead
 * of restarting. Owns the whole policy for one player: which positions are
 * worth keeping, when a recording counts as heard, and how a write reaches
 * the sidecar. The player itself only reports what happened (playback paused,
 * playback ended, the player is unloading).
 * @module player/PlaybackPositionMemory
 */

import {
	PLAYBACK_MEMORY_MIN_SECONDS,
	PLAYBACK_MEMORY_TAIL_SECONDS,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';

/**
 * Owns the remembered playback position for one recording.
 */
export class PlaybackPositionMemory {
	/**
	 * Last position handed to the store, so the repeated pauses a listener
	 * produces at one spot do not each queue a write. Null means nothing has
	 * been written yet this session.
	 */
	private written: number | null = null;

	/**
	 * @param store - Sidecar persistence
	 * @param filePath - Vault-relative path of the recording
	 */
	constructor(
		private readonly store: RecordingSidecarStore,
		private readonly filePath: string,
	) {}

	/**
	 * Reads the position this recording was left at.
	 * @returns The stored offset in seconds, or null when none is stored or
	 *   the sidecar could not be read
	 */
	async stored(): Promise<number | null> {
		try {
			const position =
				(await this.store.getPlayback(this.filePath))?.position ?? null;
			// Seed what is on disk, so a recording heard to the end without a
			// pause clears a position stored in an earlier session, while one
			// that never had a position is not written to on every unload.
			this.written = position ?? 0;
			return position;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the playback position for ${this.filePath}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Records where playback stands. A position in the opening seconds, or
	 * within the closing seconds of a known duration, forgets the recording
	 * instead: neither is a place a listener wants to be returned to, and
	 * forgetting is what lets a sidecar holding nothing else be deleted.
	 *
	 * The offset is stored whole-second, which is the granularity a listener
	 * can tell apart and the granularity that makes the unchanged-position
	 * check upstream actually skip a write.
	 * @param position - Current playback offset in seconds
	 * @param duration - Track duration in seconds, or null while unknown
	 */
	remember(position: number, duration: number | null): void {
		const seconds = Math.floor(Math.max(0, position));
		const finished =
			duration !== null &&
			seconds >= duration - PLAYBACK_MEMORY_TAIL_SECONDS;
		if (seconds < PLAYBACK_MEMORY_MIN_SECONDS || finished) {
			this.forget();
			return;
		}
		if (this.written === seconds) {
			return;
		}
		this.written = seconds;
		this.write({ position: seconds, updatedAt: new Date().toISOString() });
	}

	/**
	 * Forgets the stored position: the recording has been heard to the end,
	 * or was never listened into far enough to be worth resuming.
	 */
	forget(): void {
		if (this.written === 0) {
			return;
		}
		this.written = 0;
		this.write(null);
	}

	/**
	 * Sends one change to the sidecar. Failures are warned about and dropped:
	 * a position is a convenience, and a listener must never be shown an error
	 * dialog because one could not be saved.
	 * @param state - Position to store, or null to clear it
	 */
	private write(state: { position: number; updatedAt: string } | null): void {
		void this.store
			.setPlayback(this.filePath, state)
			.catch((error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to save the playback position for ${this.filePath}:`,
					error,
				);
			});
	}
}
