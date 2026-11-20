/**
 * Crash recovery of a desktop session that records two tracks, driven
 * through the real RecordingManager, the real SessionJournal, the real
 * RecoveryService and the real track merge over one in-memory vault. A
 * session that loses Obsidian mid-recording leaves raw segments and a
 * journal entry naming them, and the next launch has to hand back what a
 * normal stop would have written: one merged file, with the raw tracks
 * beside it.
 * @module tests/integration/multiTrackCrashRecovery.test
 */

import type { App } from 'obsidian';
import { SessionJournal } from 'src/recording/SessionJournal';
import type { JournalSession } from 'src/recording/SessionJournal';
import type { TrackWriteQueue } from 'src/recording/TrackWriteQueue';
import type { TrackAudioSource } from 'src/recording/AudioStreamHandler';
import type { RecordingTarget } from 'src/types';
import {
	collectRecoverableSessions,
	recoverSession,
} from 'src/recording/RecoveryService';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { encodeAudioBuffer } from 'src/audio/AudioEncoder';
import { at } from '../helpers/assertions';
import { internalsOf } from '../helpers/doubles';
import { useDesktopPlatform } from '../helpers/platform';
import {
	createVaultApp,
	installMultiTrackRecorders,
	installRecordingMediaStubs,
	startJournaledRecording,
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

/** A microphone lowered by 6 dB beside a second input left as captured. */
const TRACK_ORDER: TrackAudioSource[] = [
	{ trackNumber: 1, deviceId: 'mic', channelMode: 'source', gainDb: -6 },
	{ trackNumber: 2, deviceId: 'line', channelMode: 'source' },
];

/** What the suite reaches into to put the segments on disk. */
interface ManagerInternals {
	chunkTargets: RecordingTarget[];
	writeQueue: TrackWriteQueue;
}

/**
 * Records one chunk on each of two tracks, flushes both to segment files and
 * loses the app without stopping, then asks the next launch what it finds.
 * @param outputMode - Whether the session merges its tracks into one file
 * @returns The vault, the journal the next launch reads, and its offer
 */
async function crashTwoTrackSession(
	outputMode: AudioRecorderSettings['outputMode'],
): Promise<{
	app: App;
	files: VaultFiles;
	journal: SessionJournal;
	offered: JournalSession;
}> {
	useDesktopPlatform();
	const files: VaultFiles = { text: new Map(), binary: new Map() };
	const app = createVaultApp(files);
	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		enableMultiTrack: true,
		outputMode,
		mixAlignTrackLevels: true,
		recordingFormat: 'webm',
		saveFolder: 'Audio',
	};
	const recorders = installMultiTrackRecorders(2);
	// A real two-track session knows its sources, and the placement the
	// merge reads comes from them
	const { getAudioStreams } = jest.requireMock<{
		getAudioStreams: jest.Mock;
	}>('src/recording/AudioStreamHandler');
	const { streams } = (await getAudioStreams()) as { streams: unknown[] };
	getAudioStreams.mockResolvedValue({ streams, trackOrder: TRACK_ORDER });
	const { journal, manager } = await startJournaledRecording(
		app,
		settings,
		JOURNAL_PATH,
	);
	recorders.forEach((recorder, index) => {
		recorder.ondataavailable?.({
			data: new Blob([new Uint8Array([index + 1, 2, 3])], {
				type: 'audio/webm',
			}),
		} as BlobEvent);
	});
	const internals = internalsOf<ManagerInternals>(manager);
	for (const target of internals.chunkTargets) {
		await target.pendingWrite;
		await internals.writeQueue.flushChunkBuffer(target);
	}
	await journal.flush();

	const nextLaunchJournal = new SessionJournal(JOURNAL_PATH, app);
	const sessions = await collectRecoverableSessions(nextLaunchJournal, app);
	expect(sessions).toHaveLength(1);
	return {
		app,
		files,
		journal: nextLaunchJournal,
		offered: at(sessions, 0),
	};
}

describe('crash recovery of an interrupted two-track session', () => {
	beforeEach(() => {
		// The stubbed AudioContext has no createMediaStreamSource, so the
		// input level monitor reports itself unavailable on every start
		jest.spyOn(console, 'warn').mockImplementation();
	});

	it('writes the merged file a normal stop would have written', async () => {
		const { app, files, journal, offered } =
			await crashTwoTrackSession('single');

		expect(offered.mergedFileBaseName).toMatch(/^recording-multitrack-/);
		expect(offered.alignTrackLevels).toBe(true);
		expect(offered.tracks.map((track) => track.gainDb)).toEqual([-6, 0]);

		const result = await recoverSession(offered, journal, app);

		const mergedPath = `Audio/${String(offered.mergedFileBaseName)}.webm`;
		expect(result.failedTracks).toEqual([]);
		expect(result.mergeFailed).toBe(false);
		expect(result.recoveredPaths).toHaveLength(3);
		expect(at(result.recoveredPaths, 2)).toBe(mergedPath);
		// The raw tracks stay beside the merged file as the safe copy
		const rawTracks = result.recoveredPaths.slice(0, 2);
		for (const path of rawTracks) {
			expect(path).toMatch(/^Audio\/recording-.*-recovered\.webm$/);
			expect(files.binary.has(path)).toBe(true);
		}
		expect(files.binary.has(mergedPath)).toBe(true);
		// Both tracks reached the one encode of the merged file
		const audioContexts = jest.mocked(AudioContext).mock.results;
		const decoder = at(audioContexts, audioContexts.length - 1).value as {
			decodeAudioData: jest.Mock;
		};
		expect(decoder.decodeAudioData).toHaveBeenCalledTimes(2);
		expect(jest.mocked(encodeAudioBuffer)).toHaveBeenLastCalledWith(
			expect.anything(),
			{ format: 'webm', bitrate: offered.bitrate },
			expect.any(Function),
		);
		// Nothing is left for the next launch to offer again
		expect(files.text.has(JOURNAL_PATH)).toBe(false);
	});

	it('keeps one file per track for a session that writes one per track', async () => {
		const { app, files, journal, offered } =
			await crashTwoTrackSession('multiple');

		expect(offered.mergedFileBaseName).toBeUndefined();

		const result = await recoverSession(offered, journal, app);

		expect(result.recoveredPaths).toHaveLength(2);
		expect(result.mergeFailed).toBe(false);
		expect(
			[...files.binary.keys()].filter((path) =>
				path.includes('multitrack'),
			),
		).toEqual([]);
	});
});
