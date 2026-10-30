/**
 * Saving a recording in the background, driven through the real
 * RecordingManager, the real save queue, the real finalizer and the real
 * SessionJournal over one in-memory vault. A stop hands the session over and
 * frees the recorder at once, so the next meeting is captured from the press
 * while the last one is still being written. Issue #149.
 * @module tests/integration/backgroundRecordingSave.test
 */

import type { App } from 'obsidian';
import { RecordingManager } from 'src/recording/RecordingManager';
import {
	ABANDONED_SAVE_MESSAGE,
	type RecordingSaveState,
} from 'src/recording/RecordingSaveQueue';
import { collectRecoverableSessions } from 'src/recording/RecoveryService';
import { SessionJournal, type JournalFile } from 'src/recording/SessionJournal';
import { RecordingStatus } from 'src/types';
import type { RecordingSaveResult } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { flushMicrotasks, waitFor } from '../helpers/async';
import { useDesktopPlatform } from '../helpers/platform';
import {
	createVaultApp,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	makeMediaRecorderDouble,
	stubAudioStreams,
	type MockMediaRecorder,
	type VaultFiles,
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

/** A recorder, its vault, and the final files the saves are writing. */
interface Rig {
	app: App;
	files: VaultFiles;
	manager: RecordingManager;
	recorder: MockMediaRecorder;
	/** Final files whose write was started, in the order it was. */
	writes: string[];
	/** Lets the oldest held final-file write finish. */
	releaseWrite: () => void;
	/** Every save that wrote a file, in the order they finished. */
	onSaved: jest.Mock<void, [RecordingSaveResult]>;
	/** Every state the background saves reported. */
	onSaveChange: jest.Mock<void, [RecordingSaveState]>;
}

/**
 * A desktop recorder whose final-file writes wait for the test, so a save can
 * be held in flight for as long as the test needs it to be.
 * @returns The rig
 */
function createRig(): Rig {
	useDesktopPlatform();
	const files: VaultFiles = { text: new Map(), binary: new Map() };
	const app = createVaultApp(files);
	const writes: string[] = [];
	const held: (() => void)[] = [];
	jest.mocked(app.vault.createBinary).mockImplementation(
		(path: string, data: ArrayBuffer) => {
			writes.push(path);
			return new Promise((resolve) => {
				held.push(() => {
					files.binary.set(path, data);
					resolve(undefined as never);
				});
			});
		},
	);
	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		recordingFormat: 'webm',
		saveFolder: 'Audio',
		showInputLevelMeter: false,
	};
	const recorder = makeMediaRecorderDouble();
	stubAudioStreams();
	const onSaved = jest.fn<void, [RecordingSaveResult]>();
	const onSaveChange = jest.fn<void, [RecordingSaveState]>();
	const manager = new RecordingManager(
		app,
		settings,
		jest.fn(),
		makeFakeMarkerStore().store,
		new SessionJournal(JOURNAL_PATH, app),
		onSaved,
		undefined,
		undefined,
		onSaveChange,
	);
	return {
		app,
		files,
		manager,
		recorder,
		writes,
		releaseWrite: () => {
			held.shift()?.();
		},
		onSaved,
		onSaveChange,
	};
}

/**
 * Records one session of a single chunk and stops it, which hands its save
 * to the queue.
 * @param rig - The rig recording it
 * @param byte - The chunk's single byte, telling sessions apart
 * @returns What the stop answered once the save was queued
 */
async function recordAndStop(rig: Rig, byte: number): Promise<string | null> {
	expect(await rig.manager.startRecording()).toBeNull();
	rig.recorder.ondataavailable?.({
		data: new Blob([new Uint8Array([byte])], { type: 'audio/webm' }),
	} as BlobEvent);
	await flushMicrotasks();
	return rig.manager.stopRecording();
}

/**
 * Waits until the saves have started the given number of final writes.
 * @param rig - The rig whose writes are held
 * @param count - How many writes have to have started
 */
async function untilWrites(rig: Rig, count: number): Promise<void> {
	await waitFor(() => rig.writes.length === count, {
		message: `${String(count)} final write(s) to start`,
	});
}

/**
 * The journal on disk, as the next launch would read it.
 * @param rig - The rig whose vault holds it
 * @returns The ids of the sessions it lists, and the segments of each
 */
function journalOnDisk(rig: Rig): Record<string, string[]> {
	const raw = rig.files.text.get(JOURNAL_PATH);
	if (raw === undefined) {
		return {};
	}
	const journal = JSON.parse(raw) as JournalFile;
	return Object.fromEntries(
		journal.sessions.map((session) => [
			session.sessionId,
			session.tracks.flatMap((track) => track.segmentPaths),
		]),
	);
}

/**
 * Lets the first of two queued saves finish and the second one start, then
 * waits for the finished session to leave the journal.
 * @param rig - The rig holding both saves
 */
async function finishFirstOfTwo(rig: Rig): Promise<void> {
	rig.releaseWrite();
	await untilWrites(rig, 2);
	await waitFor(() => rig.onSaved.mock.calls.length === 1, {
		message: 'the first save to finish',
	});
	await waitFor(() => Object.keys(journalOnDisk(rig)).length === 1, {
		message: 'the finished session to leave the journal',
	});
}

describe('a recording saved in the background', () => {
	it('lets a new recording start while the last one is still being written', async () => {
		const rig = createRig();

		expect(await recordAndStop(rig, 1)).toBeNull();
		await untilWrites(rig, 1);

		// The first save is held at its final write, and the recorder is
		// already free: a press starts the next meeting from that moment.
		expect(rig.manager.getStatus()).toBe(RecordingStatus.Idle);
		expect(rig.manager.getSaveState().status).toBe(RecordingStatus.Saving);
		expect(await rig.manager.startRecording()).toBeNull();
		expect(rig.manager.getStatus()).toBe(RecordingStatus.Recording);

		rig.releaseWrite();
		await waitFor(() => rig.onSaved.mock.calls.length === 1, {
			message: 'the first save to finish',
		});
		expect(rig.files.binary.has(rig.writes[0] ?? '')).toBe(true);
	});

	// A quick note refuses to start beside a live capture, and a save is no
	// capture: the microphone was released before it began.
	it('leaves no live session for a quick note to wait on', async () => {
		const rig = createRig();

		await recordAndStop(rig, 1);
		await untilWrites(rig, 1);

		expect(rig.manager.isSessionActive()).toBe(false);
	});

	it('saves two recordings stopped in a row one after the other', async () => {
		const rig = createRig();

		await recordAndStop(rig, 1);
		await untilWrites(rig, 1);
		await recordAndStop(rig, 2);
		await flushMicrotasks(20);

		// The second save waits behind the first and says so, and has not
		// started a write of its own.
		expect(rig.writes).toHaveLength(1);
		expect(rig.manager.getSaveState().waiting).toBe(1);

		rig.releaseWrite();
		await untilWrites(rig, 2);
		rig.releaseWrite();
		await waitFor(() => rig.onSaved.mock.calls.length === 2, {
			message: 'both saves to finish',
		});

		// Each save fired its own post-save hook, with its own file, in the
		// order the recordings were stopped.
		expect(
			rig.onSaved.mock.calls.map(([result]) => result.audioPaths),
		).toEqual([[rig.writes[0]], [rig.writes[1]]]);
		expect(rig.writes[0]).not.toBe(rig.writes[1]);
		expect(rig.onSaveChange).toHaveBeenCalledWith(
			expect.objectContaining({
				status: RecordingStatus.Saving,
				waiting: 1,
			}),
		);
		expect(rig.manager.getSaveState().status).toBe(RecordingStatus.Idle);
	});

	// The finalizer strikes the segments it removed from the journal. With two
	// sessions open at once, the old one's cleanup must not reach the new one.
	it("keeps each session's journal entry to its own segments", async () => {
		const rig = createRig();

		await recordAndStop(rig, 1);
		await untilWrites(rig, 1);
		await recordAndStop(rig, 2);
		await waitFor(() => Object.keys(journalOnDisk(rig)).length === 2, {
			message: 'both sessions to be journaled',
		});
		const [first, second] = Object.keys(journalOnDisk(rig));

		await finishFirstOfTwo(rig);

		const journal = journalOnDisk(rig);
		expect(first).toBeDefined();
		expect(journal[first ?? '']).toBeUndefined();
		expect(journal[second ?? '']).toEqual([
			expect.stringMatching(/-part1\.webm\.tmp$/),
		]);
	});

	// Obsidian killed while a save runs: the next launch must offer that
	// session and nothing a save already finished.
	it('leaves a save cut short for recovery and a finished one out of it', async () => {
		const rig = createRig();
		await recordAndStop(rig, 1);
		await untilWrites(rig, 1);
		await recordAndStop(rig, 2);
		await finishFirstOfTwo(rig);

		rig.manager.cleanup();
		const offered = await collectRecoverableSessions(
			new SessionJournal(JOURNAL_PATH, rig.app),
			rig.app,
		);

		expect(offered.map((session) => session.sessionId)).toEqual(
			Object.keys(journalOnDisk(rig)),
		);
		expect(offered).toHaveLength(1);
	});

	it('gives up a save still waiting when the plugin unloads', async () => {
		const rig = createRig();
		await recordAndStop(rig, 1);
		await untilWrites(rig, 1);
		await rig.manager.startRecording();
		rig.recorder.ondataavailable?.({
			data: new Blob([new Uint8Array([2])], { type: 'audio/webm' }),
		} as BlobEvent);
		await flushMicrotasks();
		const waiting = rig.manager.stopRecording({ untilSaved: true });
		await waitFor(() => rig.manager.getSaveState().waiting === 1, {
			message: 'the second save to be queued',
		});

		rig.manager.cleanup();
		rig.releaseWrite();

		// The waiting save never ran, and its session stays journaled for
		// the next launch to offer.
		await expect(waiting).resolves.toBe(ABANDONED_SAVE_MESSAGE);
		expect(rig.writes).toHaveLength(1);
		expect(Object.keys(journalOnDisk(rig))).toHaveLength(1);
	});
});
