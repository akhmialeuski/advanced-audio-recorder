/**
 * Crash recovery of a mobile recording session, driven through the real
 * RecordingManager, the real SessionJournal, and the real RecoveryService
 * over one in-memory vault. A phone that loses its app mid-session leaves
 * finished part files and a journal entry pointing at them, so the suite
 * records two rotations, drops the session without ever stopping it, and
 * asks the next launch what it finds.
 * @module tests/integration/mobileCrashRecovery.test
 */

import type { App } from 'obsidian';
import { RecordingManager } from 'src/recording/RecordingManager';
import { SessionJournal } from 'src/recording/SessionJournal';
import type { JournalSession } from 'src/recording/SessionJournal';
import {
	collectRecoverableSessions,
	discardSession,
	recoverSession,
} from 'src/recording/RecoveryService';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';
import { internalsOf } from '../helpers/doubles';
import { useMobilePlatform } from '../helpers/platform';
import {
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	makeMediaRecorderDouble,
	stubAudioStreams,
	type MockMediaRecorder,
} from '../helpers/recordingManagerTestKit';

jest.mock('src/recording/AudioStreamHandler', () =>
	require('../mocks/modules/audioStreamHandler'),
);
jest.mock('src/audio/AudioEncoder', () =>
	require('../mocks/modules/audioEncoder'),
);
jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

installRecordingMediaStubs();

/** Where the journal lives next to the plugin's data.json. */
const JOURNAL_PATH = '.obsidian/plugins/aar/recording-journal.json';

/** The vault contents the suite writes through and reads back. */
interface VaultFiles {
	text: Map<string, string>;
	binary: Map<string, ArrayBuffer>;
}

/** Rotation state the suite has to await between parts. */
interface ManagerInternals {
	chunkTargets: { pendingWrite: Promise<void> }[];
	rotation: { rotationPromise: Promise<void> | null };
}

/**
 * An App whose adapter is two maps, so a file written by the recording
 * pipeline is a file the recovery can find again.
 * @param files - Backing stores, shared with the test
 * @returns The App double
 */
function createVaultApp(files: VaultFiles): App {
	return {
		vault: {
			adapter: {
				exists: jest.fn((path: string) =>
					Promise.resolve(
						files.text.has(path) || files.binary.has(path),
					),
				),
				read: jest.fn((path: string) => {
					const content = files.text.get(path);
					return content === undefined
						? Promise.reject(new Error(`missing: ${path}`))
						: Promise.resolve(content);
				}),
				write: jest.fn((path: string, data: string) => {
					files.text.set(path, data);
					return Promise.resolve();
				}),
				readBinary: jest.fn((path: string) => {
					const content = files.binary.get(path);
					return content === undefined
						? Promise.reject(new Error(`missing: ${path}`))
						: Promise.resolve(content);
				}),
				writeBinary: jest.fn((path: string, data: ArrayBuffer) => {
					files.binary.set(path, data);
					return Promise.resolve();
				}),
				remove: jest.fn((path: string) => {
					files.text.delete(path);
					files.binary.delete(path);
					return Promise.resolve();
				}),
			},
			createBinary: jest.fn((path: string, data: ArrayBuffer) => {
				files.binary.set(path, data);
				return Promise.resolve();
			}),
			createFolder: jest.fn().mockResolvedValue(undefined),
		},
		workspace: {
			getActiveViewOfType: jest.fn().mockReturnValue(null),
			getActiveFile: jest.fn().mockReturnValue(null),
		},
	} as unknown as App;
}

/** Everything one interrupted mobile session is built from. */
interface MobileSession {
	app: App;
	files: VaultFiles;
	journal: SessionJournal;
	manager: RecordingManager;
	recorder: MockMediaRecorder;
}

/**
 * Starts a mobile session that rotates a part every minute, with the
 * clock frozen at zero so the test moves it by hand.
 * @returns The session and the vault it records into
 */
async function startMobileSession(): Promise<MobileSession> {
	useMobilePlatform();
	jest.useFakeTimers();
	jest.setSystemTime(0);

	const files: VaultFiles = { text: new Map(), binary: new Map() };
	const app = createVaultApp(files);
	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		recordingFormat: 'webm',
		saveFolder: 'Audio',
		autoSplitEnabled: true,
		splitChunkMinutes: 1,
	};
	const recorder = makeMediaRecorderDouble({ state: 'recording' });
	stubAudioStreams();
	const journal = new SessionJournal(JOURNAL_PATH, app);
	const manager = new RecordingManager(
		app,
		settings,
		jest.fn(),
		makeFakeMarkerStore().store,
		journal,
	);

	await manager.startRecording();
	return { app, files, journal, manager, recorder };
}

/**
 * Moves the clock past the part boundary and delivers a chunk, which is
 * what makes the manager rotate, then waits for the part file.
 * @param session - The running session
 * @param atMs - Where to put the clock
 */
async function rotateAt(session: MobileSession, atMs: number): Promise<void> {
	jest.setSystemTime(atMs);
	session.recorder.ondataavailable?.({
		data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
	} as BlobEvent);
	const internals = internalsOf<ManagerInternals>(session.manager);
	await at(internals.chunkTargets, 0).pendingWrite;
	await flushMicrotasks(10);
	await internals.rotation.rotationPromise;
}

/**
 * Records two parts and then loses the app, leaving only what already
 * reached disk. The journal is flushed first because that is what the
 * journal promises between rotations: the write of a finished part has
 * landed by the time the next one starts.
 * @returns The sessions the next launch finds, and the vault they name
 */
async function interruptAfterTwoParts(): Promise<{
	session: MobileSession;
	nextLaunchJournal: SessionJournal;
}> {
	const session = await startMobileSession();
	await rotateAt(session, 61_000);
	await rotateAt(session, 122_000);
	await session.journal.flush();

	return {
		session,
		nextLaunchJournal: new SessionJournal(JOURNAL_PATH, session.app),
	};
}

/**
 * Interrupts a two-part session and asks the next launch what it finds,
 * which is where all three decisions start from.
 * @returns The session, the journal the next launch reads, and the offer
 */
async function offerAfterCrash(): Promise<{
	session: MobileSession;
	nextLaunchJournal: SessionJournal;
	sessions: JournalSession[];
	parts: string[];
}> {
	const { session, nextLaunchJournal } = await interruptAfterTwoParts();
	const sessions = await collectRecoverableSessions(
		nextLaunchJournal,
		session.app,
	);
	return {
		session,
		nextLaunchJournal,
		sessions,
		parts: at(at(sessions, 0).tracks, 0).partPaths,
	};
}

describe('crash recovery of an interrupted mobile session', () => {
	beforeEach(() => {
		// The stubbed AudioContext has no createMediaStreamSource, so the
		// input level monitor reports itself unavailable on every start
		jest.spyOn(console, 'warn').mockImplementation();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('offers the finished parts and the length they hold', async () => {
		const { session, sessions } = await offerAfterCrash();

		expect(sessions).toHaveLength(1);
		const offered = at(sessions, 0);
		expect(offered.captureMode).toBe('rotation');
		// Two full minutes of capture reached disk as two parts
		expect(offered.recordedMs).toBe(122_000);
		const track = at(offered.tracks, 0);
		expect(track.partPaths).toHaveLength(2);
		expect(at(track.partPaths, 0)).toMatch(
			/^Audio\/recording-Track1-.*-part1\.webm$/,
		);
		expect(at(track.partPaths, 1)).toMatch(/-part2\.webm$/);
		// A rotation converts and removes its segments as it goes, so the
		// interrupted session left no mid-stream fragment behind
		expect(track.segmentPaths).toEqual([]);
		expect(
			[...session.files.binary.keys()].filter((path) =>
				path.endsWith('.tmp'),
			),
		).toEqual([]);
	});

	it('keeps the parts where they are when the user accepts them', async () => {
		const { session, nextLaunchJournal, sessions, parts } =
			await offerAfterCrash();

		const result = await recoverSession(
			at(sessions, 0),
			nextLaunchJournal,
			session.app,
		);

		// The parts already carry the names the normal finalization gives
		// them, so accepting the session is a matter of naming the set and
		// letting the journal entry go
		expect(result.recoveredPaths).toEqual(parts);
		expect(result.failedTracks).toEqual([]);
		for (const part of parts) {
			expect(session.files.binary.has(part)).toBe(true);
		}
		expect(session.files.text.has(JOURNAL_PATH)).toBe(false);
	});

	it('deletes the parts when the user turns the session down', async () => {
		const { session, nextLaunchJournal, sessions, parts } =
			await offerAfterCrash();

		const failed = await discardSession(
			at(sessions, 0),
			nextLaunchJournal,
			session.app,
		);

		expect(failed).toEqual([]);
		for (const part of parts) {
			expect(session.files.binary.has(part)).toBe(false);
		}
		expect(session.files.text.has(JOURNAL_PATH)).toBe(false);
	});

	it('self-clears without prompting when the parts are gone', async () => {
		const { session, nextLaunchJournal } = await interruptAfterTwoParts();
		// The user tidied the vault before reopening it
		session.files.binary.clear();

		const sessions = await collectRecoverableSessions(
			nextLaunchJournal,
			session.app,
		);

		expect(sessions).toEqual([]);
		expect(session.files.text.has(JOURNAL_PATH)).toBe(false);
	});
});
