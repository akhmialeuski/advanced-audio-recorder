/**
 * Startup recovery for recording sessions that died mid-recording
 * (crash, power loss, plugin unload). Reads the session journal,
 * prunes entries whose temporary files no longer exist, and either
 * reassembles the surviving segments into playable audio files or
 * discards them. Recovery never transcodes: a raw reassembled
 * container is the safest artifact a truncated stream can produce.
 * @module recording/RecoveryService
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX, FORMAT_WAV } from '../constants';
import { assembleWavFromPcmSegmentFiles } from '../audio/WavEncoder';
import {
	removeTemporaryArtifacts,
	resolveUniquePathInDirectory,
} from '../audio/RecordingFileManager';
import { JOURNAL_VERSION } from './SessionJournal';
import type {
	JournalSession,
	JournalTrack,
	SessionJournal,
} from './SessionJournal';

/**
 * Outcome of recovering one session.
 */
export interface RecoveryResult {
	/** Paths of the recovered audio files. */
	recoveredPaths: string[];
	/** Base names of tracks that could not be recovered. */
	failedTracks: string[];
}

/**
 * Returns the directory part of a vault-relative path.
 * @param path - Vault-relative file path
 * @returns Directory path, or empty string for root-level files
 */
function directoryOf(path: string): string {
	const segments = path.split('/');
	segments.pop();
	return segments.join('/');
}

/**
 * Collects the sessions that still have recoverable segment files on
 * disk. Prunes segments that no longer exist (and whole tracks and
 * sessions without any), persisting the pruned journal: a crash
 * before the first flush therefore self-clears without prompting.
 * A corrupt journal is deleted - nothing in it is actionable. A
 * journal written by a newer plugin version is left untouched so a
 * downgrade never destroys recovery data it cannot interpret.
 * @param journal - Session journal
 * @param app - Obsidian App instance
 * @returns Sessions worth offering recovery for
 */
export async function collectRecoverableSessions(
	journal: SessionJournal,
	app: App,
): Promise<JournalSession[]> {
	const { data, corrupt } = await journal.readJournal();
	if (corrupt) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Recording journal is corrupt; removing it`,
		);
		await journal.discardJournalFile();
		return [];
	}
	if (!data || data.sessions.length === 0) {
		return [];
	}
	if (data.version > JOURNAL_VERSION) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Recording journal was written by a newer plugin version; leaving it untouched`,
		);
		return [];
	}

	const pruned: JournalSession[] = [];
	for (const session of data.sessions) {
		const tracks: JournalTrack[] = [];
		for (const track of session.tracks) {
			const existing: string[] = [];
			for (const path of track.segmentPaths) {
				if (await app.vault.adapter.exists(path)) {
					existing.push(path);
				}
			}
			if (existing.length === 0) {
				continue;
			}
			// A MediaRecorder stream is only playable from its first
			// segment (it carries the container header); losing it makes
			// the track discard-only
			const headerLost =
				!track.isPcm && existing[0] !== track.segmentPaths[0];
			tracks.push({
				...track,
				segmentPaths: existing,
				headerLost,
			});
		}
		if (tracks.length > 0) {
			pruned.push({ ...session, tracks });
		}
	}

	await journal.replaceSessions(pruned);
	return pruned;
}

/**
 * Persists a session update after recovery or discard: the session is
 * replaced (or dropped when it has no tracks left) among the journaled
 * sessions.
 * @param journal - Session journal
 * @param session - Updated session
 */
async function persistSessionUpdate(
	journal: SessionJournal,
	session: JournalSession,
): Promise<void> {
	const { data } = await journal.readJournal();
	const others = (data?.sessions ?? []).filter(
		(entry) => entry.sessionId !== session.sessionId,
	);
	const remaining = session.tracks.length > 0 ? [...others, session] : others;
	await journal.replaceSessions(remaining);
}

/**
 * Recovers one interrupted session: PCM tracks are reassembled into
 * WAV files, MediaRecorder tracks are byte-concatenated into their
 * recorder container format. The output lands in the directory of the
 * first segment - where the user was recording - not in the currently
 * configured save folder, which may have changed since the crash.
 * Successfully recovered tracks leave the journal; failed tracks stay
 * for the next launch.
 * @param session - Session to recover (as returned by collect)
 * @param journal - Session journal
 * @param app - Obsidian App instance
 * @returns Recovered file paths and unrecoverable track names
 */
export async function recoverSession(
	session: JournalSession,
	journal: SessionJournal,
	app: App,
): Promise<RecoveryResult> {
	const result: RecoveryResult = { recoveredPaths: [], failedTracks: [] };
	const remainingTracks: JournalTrack[] = [];

	for (const track of session.tracks) {
		try {
			if (track.segmentPaths.length === 0) {
				continue;
			}
			if (!track.isPcm && track.headerLost) {
				// No container header - the data is not playable
				result.failedTracks.push(track.fileBaseName);
				remainingTracks.push(track);
				continue;
			}

			let outputBytes: ArrayBuffer;
			let extension: string;
			if (track.isPcm) {
				// Stream the segments into one preallocated buffer: an
				// interrupted long recording holds gigabytes of PCM, and
				// reading everything before assembly would double the
				// peak memory in exactly the scenario recovery targets
				outputBytes = await assembleWavFromPcmSegmentFiles(
					track.segmentPaths,
					track.pcmChannels,
					track.pcmSampleRate,
					app,
				);
				extension = FORMAT_WAV;
			} else {
				const segments: ArrayBuffer[] = [];
				for (const path of track.segmentPaths) {
					segments.push(await app.vault.adapter.readBinary(path));
				}
				const totalBytes = segments.reduce(
					(sum, segment) => sum + segment.byteLength,
					0,
				);
				const combined = new Uint8Array(totalBytes);
				let offset = 0;
				for (const segment of segments) {
					combined.set(new Uint8Array(segment), offset);
					offset += segment.byteLength;
				}
				outputBytes = combined.buffer;
				extension = session.recorderFormat;
			}

			const directory = directoryOf(track.segmentPaths[0]);
			const outputPath = await resolveUniquePathInDirectory(
				directory,
				`${track.fileBaseName}-recovered.${extension}`,
				app,
			);
			await app.vault.createBinary(outputPath, outputBytes);
			result.recoveredPaths.push(outputPath);

			await removeTemporaryArtifacts(
				track.segmentPaths,
				'Failed to remove recovered segment file',
				app,
			);
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to recover track:`,
				track.fileBaseName,
				error,
			);
			result.failedTracks.push(track.fileBaseName);
			remainingTracks.push(track);
		}
	}

	await persistSessionUpdate(journal, {
		...session,
		tracks: remainingTracks,
	});
	return result;
}

/**
 * Discards the temporary files of one interrupted session. Finalized
 * part files (partPaths) are never touched - they are complete audio
 * the user may want to keep. Segments that could not be removed stay
 * journaled for a retry on the next launch.
 * @param session - Session to discard (as returned by collect)
 * @param journal - Session journal
 * @param app - Obsidian App instance
 * @returns Paths that could not be removed
 */
export async function discardSession(
	session: JournalSession,
	journal: SessionJournal,
	app: App,
): Promise<string[]> {
	const allSegments = session.tracks.flatMap((track) => track.segmentPaths);
	const failedPaths = await removeTemporaryArtifacts(
		allSegments,
		'Failed to discard segment file of an interrupted recording',
		app,
	);

	const failed = new Set(failedPaths);
	const remainingTracks = session.tracks
		.map((track) => ({
			...track,
			segmentPaths: track.segmentPaths.filter((path) => failed.has(path)),
		}))
		.filter((track) => track.segmentPaths.length > 0);

	await persistSessionUpdate(journal, {
		...session,
		tracks: remainingTracks,
	});
	return failedPaths;
}
