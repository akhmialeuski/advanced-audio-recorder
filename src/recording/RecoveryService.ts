/**
 * Startup recovery for recording sessions that died mid-recording
 * (crash, power loss, plugin unload). Reads the session journal,
 * prunes entries whose files no longer exist, and either hands the
 * surviving audio back to the user or discards it. What survives
 * depends on how the session wrote to disk: raw mid-stream segments
 * that have to be reassembled, or rotation parts that are already
 * complete files. Recovery never transcodes, because a raw
 * reassembled container is the safest artifact a truncated stream can
 * produce.
 * @module recording/RecoveryService
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX, FORMAT_WAV } from '../constants';
import { concatArrayBuffers } from '../utils/buffers';
import { directoryOf } from '../utils/paths';
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
 * Whether the session's part files are the interrupted recording
 * itself. They are on the rotation capture mode, where every part is a
 * forced buffer flush; on the stream mode they are auto-split
 * deliverables the user asked for, which recovery reports on but never
 * creates, moves, or deletes. A journal written before the field
 * existed can only have come from the stream mode.
 * @param session - Journaled session
 * @returns True when recovery owns the part files
 */
function ownsPartFiles(session: JournalSession): boolean {
	return session.captureMode === 'rotation';
}

/**
 * Keeps the paths that still exist on disk, in their journaled order.
 * @param paths - Journaled file paths
 * @param app - Obsidian App instance
 * @returns The subset that is still there
 */
async function survivingPaths(paths: string[], app: App): Promise<string[]> {
	const existing: string[] = [];
	for (const path of paths) {
		if (await app.vault.adapter.exists(path)) {
			existing.push(path);
		}
	}
	return existing;
}

/**
 * Collects the sessions that still have recoverable files on disk.
 * Prunes segments and part files that no longer exist (and whole
 * tracks and sessions without any), persisting the pruned journal: a
 * crash before the first flush therefore self-clears without
 * prompting. A corrupt journal is deleted - nothing in it is
 * actionable. A journal written by a newer plugin version is left
 * untouched so a downgrade never destroys recovery data it cannot
 * interpret.
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
			const segmentPaths = await survivingPaths(track.segmentPaths, app);
			// Part files are checked too: on a rotation session they are
			// the whole of what can be recovered, and on any session an
			// entry pointing at a file the user has since deleted must
			// not keep the journal alive
			const partPaths = await survivingPaths(track.partPaths, app);
			if (segmentPaths.length === 0 && partPaths.length === 0) {
				continue;
			}
			// A MediaRecorder stream is only playable from its first
			// segment (it carries the container header); losing it makes
			// the segments discard-only
			const headerLost =
				!track.isPcm &&
				segmentPaths.length > 0 &&
				segmentPaths[0] !== track.segmentPaths[0];
			tracks.push({
				...track,
				segmentPaths,
				partPaths,
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
 * Recovers one interrupted session. A rotation session's part files
 * are already complete recordings carrying the names the normal
 * finalization would have given them, so recovering them means keeping
 * them and naming the set back to the user. Whatever segments a
 * session left are reassembled: PCM tracks into WAV files,
 * MediaRecorder tracks byte-concatenated into their recorder container
 * format. Reassembled output lands in the directory of the first
 * segment - where the user was recording - not in the currently
 * configured save folder, which may have changed since the crash.
 * Successfully recovered tracks leave the journal; tracks whose
 * segments failed stay for the next launch.
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
	const adoptsParts = ownsPartFiles(session);

	for (const track of session.tracks) {
		if (adoptsParts) {
			result.recoveredPaths.push(...track.partPaths);
		}
		// An adopted part is settled whatever happens to the segments of
		// the same track, so a track kept for a retry keeps only those
		const journaled = adoptsParts ? { ...track, partPaths: [] } : track;
		try {
			if (track.segmentPaths.length === 0) {
				continue;
			}
			if (!track.isPcm && track.headerLost) {
				// No container header - the data is not playable
				result.failedTracks.push(track.fileBaseName);
				remainingTracks.push(journaled);
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
				outputBytes = concatArrayBuffers(segments).buffer;
				extension = session.recorderFormat;
			}

			const firstSegmentPath = track.segmentPaths[0];
			if (firstSegmentPath === undefined) {
				continue;
			}
			const directory = directoryOf(firstSegmentPath);
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
			remainingTracks.push(journaled);
		}
	}

	await persistSessionUpdate(journal, {
		...session,
		tracks: remainingTracks,
	});
	return result;
}

/**
 * Discards the files of one interrupted session that the user turned
 * down. Segments always go. Part files go only on the rotation capture
 * mode, where they are the recording being turned down; on the stream
 * mode they are auto-split output the user already has and they are
 * never touched. Anything that could not be removed stays journaled
 * for a retry on the next launch.
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
	const discardsParts = ownsPartFiles(session);
	const doomed = session.tracks.flatMap((track) => [
		...track.segmentPaths,
		...(discardsParts ? track.partPaths : []),
	]);
	const failedPaths = await removeTemporaryArtifacts(
		doomed,
		'Failed to discard a file of an interrupted recording',
		app,
	);

	const failed = new Set(failedPaths);
	const remainingTracks = session.tracks
		.map((track) => ({
			...track,
			segmentPaths: track.segmentPaths.filter((path) => failed.has(path)),
			partPaths: discardsParts
				? track.partPaths.filter((path) => failed.has(path))
				: track.partPaths,
		}))
		.filter(
			(track) =>
				track.segmentPaths.length > 0 ||
				(discardsParts && track.partPaths.length > 0),
		);

	await persistSessionUpdate(journal, {
		...session,
		tracks: remainingTracks,
	});
	return failedPaths;
}
