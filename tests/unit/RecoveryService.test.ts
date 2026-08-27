/**
 * Unit tests for RecoveryService module.
 * Tests journal pruning, session recovery for both capture paths, and
 * discard semantics.
 * @module tests/unit/RecoveryService.test
 */

import {
	collectRecoverableSessions,
	recoverSession,
	discardSession,
} from 'src/recording/RecoveryService';
import { at, defined } from '../helpers/assertions';
import { SessionJournal, JOURNAL_VERSION } from 'src/recording/SessionJournal';
import type {
	JournalFile,
	JournalSession,
	JournalTrack,
} from 'src/recording/SessionJournal';
import type { App } from 'obsidian';
import { createMockApp } from '../helpers/createApp';

jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

import {
	assembleWavFromPcmSegmentFiles,
	WavSizeLimitError,
} from 'src/audio/WavEncoder';

const JOURNAL_PATH = '.obsidian/plugins/aar/recording-journal.json';

const createTrack = (overrides: Partial<JournalTrack> = {}): JournalTrack => ({
	fileBaseName: 'recording-Track1-stamp',
	isPcm: false,
	pcmChannels: 1,
	pcmSampleRate: 44100,
	segmentPaths: [],
	partPaths: [],
	...overrides,
});

const createJournalSession = (
	overrides: Partial<JournalSession> = {},
): JournalSession => ({
	sessionId: 'session-1',
	startedAt: 1765533600000,
	outputFormat: 'webm',
	recorderFormat: 'webm',
	bitrate: 128000,
	tracks: [createTrack()],
	...overrides,
});

/** The two part files a mobile session is left holding here. */
const TWO_PARTS = ['Audio/rec-part1.webm', 'Audio/rec-part2.webm'];

/**
 * A session whose part files are the recording itself, which is what a
 * platform that rotates every flush leaves behind.
 * @param track - What this case varies about the single track
 * @param overrides - What it varies about the session
 * @returns The journaled session
 */
const rotationSession = (
	track: Partial<JournalTrack> = { partPaths: TWO_PARTS },
	overrides: Partial<JournalSession> = {},
): JournalSession =>
	createJournalSession({
		captureMode: 'rotation',
		tracks: [createTrack(track)],
		...overrides,
	});

/**
 * A session whose part files are auto-split deliverables the user
 * already has, which is what a platform allowed to flush raw mid-stream
 * segments leaves behind.
 * @param track - What this case varies about the single track
 * @returns The journaled session
 */
const streamSession = (track: Partial<JournalTrack>): JournalSession =>
	createJournalSession({ tracks: [createTrack(track)] });

describe('RecoveryService', () => {
	/** In-memory text file store (journal). */
	let textFiles: Map<string, string>;
	/** In-memory binary file store (segments and recovered audio). */
	let binaryFiles: Map<string, ArrayBuffer>;
	let journal: SessionJournal;
	let mockApp: App;

	const storeJournal = (
		sessions: JournalSession[],
		version?: number,
	): void => {
		textFiles.set(
			JOURNAL_PATH,
			JSON.stringify({
				version: version ?? JOURNAL_VERSION,
				sessions,
			}),
		);
	};

	/**
	 * Puts files on disk for the paths a case journals.
	 * @param paths - Vault-relative paths to create
	 */
	const seedFiles = (paths: string[]): void => {
		for (const path of paths) {
			binaryFiles.set(path, new ArrayBuffer(64));
		}
	};

	const readStoredJournal = (): JournalFile | null => {
		const raw = textFiles.get(JOURNAL_PATH);
		return raw ? (JSON.parse(raw) as JournalFile) : null;
	};

	beforeEach(() => {
		jest.spyOn(console, 'warn').mockImplementation();
		jest.spyOn(console, 'error').mockImplementation();

		textFiles = new Map();
		binaryFiles = new Map();
		mockApp = createMockApp({
			vault: {
				adapter: {
					exists: jest.fn((path: string) =>
						Promise.resolve(
							textFiles.has(path) || binaryFiles.has(path),
						),
					),
					read: jest.fn((path: string) => {
						const content = textFiles.get(path);
						return content !== undefined
							? Promise.resolve(content)
							: Promise.reject(new Error('missing'));
					}),
					write: jest.fn((path: string, data: string) => {
						textFiles.set(path, data);
						return Promise.resolve();
					}),
					readBinary: jest.fn((path: string) => {
						const content = binaryFiles.get(path);
						return content !== undefined
							? Promise.resolve(content)
							: Promise.reject(new Error('missing'));
					}),
					remove: jest.fn((path: string) => {
						textFiles.delete(path);
						binaryFiles.delete(path);
						return Promise.resolve();
					}),
				},
				createBinary: jest.fn((path: string, data: ArrayBuffer) => {
					binaryFiles.set(path, data);
					return Promise.resolve();
				}),
			},
		}).app;
		journal = new SessionJournal(JOURNAL_PATH, mockApp);
	});

	describe('collectRecoverableSessions', () => {
		it('returns nothing when no journal exists', async () => {
			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
		});

		it('deletes a corrupt journal without prompting', async () => {
			textFiles.set(JOURNAL_PATH, '{not json');

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(false);
		});

		it('leaves a newer-version journal untouched', async () => {
			storeJournal([createJournalSession()], JOURNAL_VERSION + 1);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(true);
		});

		it('prunes missing segments and self-clear empty sessions', async () => {
			storeJournal([
				createJournalSession({
					tracks: [createTrack({ segmentPaths: ['gone.tmp'] })],
				}),
			]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			// The pruned journal has no sessions left, so the file is gone
			expect(textFiles.has(JOURNAL_PATH)).toBe(false);
		});

		it('keeps sessions with surviving segments', async () => {
			binaryFiles.set('Audio/rec-part1.webm.tmp', new ArrayBuffer(8));
			storeJournal([
				createJournalSession({
					tracks: [
						createTrack({
							segmentPaths: [
								'Audio/rec-part1.webm.tmp',
								'Audio/rec-part2.webm.tmp',
							],
						}),
					],
				}),
			]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toHaveLength(1);
			expect(at(at(sessions, 0).tracks, 0).segmentPaths).toEqual([
				'Audio/rec-part1.webm.tmp',
			]);
		});

		it('keeps a rotation session whose only files are its parts', async () => {
			// The mobile shape: every flush rotated a whole part, so nothing
			// mid-stream is left and the parts are all there is to offer
			seedFiles(TWO_PARTS);
			storeJournal([rotationSession(undefined, { recordedMs: 900_000 })]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toHaveLength(1);
			expect(at(at(sessions, 0).tracks, 0).partPaths).toEqual(TWO_PARTS);
			expect(at(at(sessions, 0).tracks, 0).headerLost).toBe(false);
		});

		it('prunes part files the user has since deleted', async () => {
			seedFiles(['Audio/rec-part2.webm']);
			storeJournal([rotationSession()]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(at(at(sessions, 0).tracks, 0).partPaths).toEqual([
				'Audio/rec-part2.webm',
			]);
		});

		it('self-clears a rotation session whose parts are all gone', async () => {
			storeJournal([rotationSession()]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(false);
		});

		it('self-clears a stream session left holding only auto-split parts', async () => {
			// A desktop rotation deletes its segments as it finalizes the
			// part, so between boundaries the journal points at finished
			// deliverables alone. Recovery neither assembles nor removes
			// those, so offering the session would open a dialog whose
			// buttons have nothing to do.
			seedFiles(TWO_PARTS);
			storeJournal([streamSession({ partPaths: TWO_PARTS })]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(false);
		});

		it('keeps the surviving parts of a stream session that still has a segment', async () => {
			seedFiles(['Audio/rec-part1.webm', 'Audio/rec-part2.webm.tmp']);
			storeJournal([
				streamSession({
					partPaths: ['Audio/rec-part1.webm'],
					segmentPaths: ['Audio/rec-part2.webm.tmp'],
				}),
			]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			// The dialog names them as output that stays untouched, so they
			// have to reach it; what they may not do is carry a session on
			// their own
			expect(at(at(sessions, 0).tracks, 0).partPaths).toEqual([
				'Audio/rec-part1.webm',
			]);
		});

		it('marks media tracks whose first segment is gone as header-lost', async () => {
			binaryFiles.set('Audio/rec-part2.webm.tmp', new ArrayBuffer(8));
			storeJournal([
				createJournalSession({
					tracks: [
						createTrack({
							segmentPaths: [
								'Audio/rec-part1.webm.tmp',
								'Audio/rec-part2.webm.tmp',
							],
						}),
					],
				}),
			]);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(at(at(sessions, 0).tracks, 0).headerLost).toBe(true);
		});
	});

	describe('recoverSession', () => {
		it('reassembles PCM tracks into a recovered WAV next to the segments', async () => {
			binaryFiles.set('Audio/rec-pcm-part1.tmp', new ArrayBuffer(4));
			binaryFiles.set('Audio/rec-pcm-part2.tmp', new ArrayBuffer(4));
			const session = createJournalSession({
				tracks: [
					createTrack({
						isPcm: true,
						pcmChannels: 2,
						pcmSampleRate: 48000,
						segmentPaths: [
							'Audio/rec-pcm-part1.tmp',
							'Audio/rec-pcm-part2.tmp',
						],
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			// Streamed straight from the segment files: recovery must not
			// read the whole track into memory before assembly
			expect(
				jest.mocked(assembleWavFromPcmSegmentFiles),
			).toHaveBeenCalledWith(
				['Audio/rec-pcm-part1.tmp', 'Audio/rec-pcm-part2.tmp'],
				2,
				48000,
				mockApp,
			);
			expect(result.recoveredPaths).toEqual([
				'Audio/recording-Track1-stamp-recovered.wav',
			]);
			expect(result.failedTracks).toEqual([]);
			// Segments consumed, journal cleared
			expect(binaryFiles.has('Audio/rec-pcm-part1.tmp')).toBe(false);
			expect(readStoredJournal()).toBeNull();
		});

		it('bytes-concatenate media tracks in capture order', async () => {
			binaryFiles.set(
				'Audio/rec-part1.webm.tmp',
				new Uint8Array([1, 2]).buffer,
			);
			binaryFiles.set(
				'Audio/rec-part2.webm.tmp',
				new Uint8Array([3, 4]).buffer,
			);
			const session = createJournalSession({
				tracks: [
					createTrack({
						segmentPaths: [
							'Audio/rec-part1.webm.tmp',
							'Audio/rec-part2.webm.tmp',
						],
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.recoveredPaths).toEqual([
				'Audio/recording-Track1-stamp-recovered.webm',
			]);
			const recovered = new Uint8Array(
				binaryFiles.get(
					'Audio/recording-Track1-stamp-recovered.webm',
				) ?? new ArrayBuffer(0),
			);
			expect(Array.from(recovered)).toEqual([1, 2, 3, 4]);
		});

		it('reports header-lost media tracks as failed and keep them journaled', async () => {
			binaryFiles.set('Audio/rec-part2.webm.tmp', new ArrayBuffer(4));
			const session = createJournalSession({
				tracks: [
					createTrack({
						segmentPaths: ['Audio/rec-part2.webm.tmp'],
						headerLost: true,
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.recoveredPaths).toEqual([]);
			expect(result.failedTracks).toEqual(['recording-Track1-stamp']);
			expect(binaryFiles.has('Audio/rec-part2.webm.tmp')).toBe(true);
			expect(readStoredJournal()?.sessions).toHaveLength(1);
		});

		// Recovery assembles through the same encoder the recording did, so a
		// session that outgrew the WAV container is refused here too. The
		// refusal the user reads at the stop therefore must not offer recovery
		// as the way to the audio: it would send them round a loop that ends
		// where it started, with the track reported as one that failed.
		it('reports a track past the container ceiling as failed and keeps it journaled', async () => {
			jest.mocked(assembleWavFromPcmSegmentFiles).mockRejectedValueOnce(
				new WavSizeLimitError(),
			);
			binaryFiles.set('Audio/rec-pcm-part1.tmp', new ArrayBuffer(4));
			const session = createJournalSession({
				outputFormat: 'wav',
				recorderFormat: 'wav',
				tracks: [
					createTrack({
						isPcm: true,
						segmentPaths: ['Audio/rec-pcm-part1.tmp'],
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.recoveredPaths).toEqual([]);
			expect(result.failedTracks).toEqual(['recording-Track1-stamp']);
			expect(binaryFiles.has('Audio/rec-pcm-part1.tmp')).toBe(true);
			expect(readStoredJournal()?.sessions).toHaveLength(1);
		});

		it('resolves name collisions with a counter suffix', async () => {
			binaryFiles.set('Audio/rec-pcm-part1.tmp', new ArrayBuffer(4));
			binaryFiles.set(
				'Audio/recording-Track1-stamp-recovered.wav',
				new ArrayBuffer(10),
			);
			const session = createJournalSession({
				tracks: [
					createTrack({
						isPcm: true,
						segmentPaths: ['Audio/rec-pcm-part1.tmp'],
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.recoveredPaths).toEqual([
				'Audio/recording-Track1-stamp-recovered_1.wav',
			]);
		});

		it('isolates per-track failures', async () => {
			binaryFiles.set('Audio/good-pcm-part1.tmp', new ArrayBuffer(4));
			binaryFiles.set('Audio/bad-pcm-part1.tmp', new ArrayBuffer(4));
			(mockApp.vault.createBinary as jest.Mock)
				.mockRejectedValueOnce(new Error('disk full'))
				.mockImplementation((path: string, data: ArrayBuffer) => {
					binaryFiles.set(path, data);
					return Promise.resolve();
				});
			const session = createJournalSession({
				tracks: [
					createTrack({
						fileBaseName: 'bad-track',
						isPcm: true,
						segmentPaths: ['Audio/bad-pcm-part1.tmp'],
					}),
					createTrack({
						fileBaseName: 'good-track',
						isPcm: true,
						segmentPaths: ['Audio/good-pcm-part1.tmp'],
					}),
				],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.failedTracks).toEqual(['bad-track']);
			expect(result.recoveredPaths).toHaveLength(1);
			// The failed track stays journaled for the next launch
			expect(
				at(defined(readStoredJournal()).sessions, 0).tracks,
			).toHaveLength(1);
			expect(
				at(at(defined(readStoredJournal()).sessions, 0).tracks, 0)
					.fileBaseName,
			).toBe('bad-track');
		});
	});

	describe('recovering a rotation session', () => {
		it('hands back the part files and clears the journal', async () => {
			seedFiles(TWO_PARTS);
			const session = rotationSession();
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			// The parts already carry the names the normal finalization would
			// have given them, so recovery keeps them where they are
			expect(result.recoveredPaths).toEqual(TWO_PARTS);
			expect(result.failedTracks).toEqual([]);
			expect(binaryFiles.has('Audio/rec-part1.webm')).toBe(true);
			expect(readStoredJournal()).toBeNull();
		});

		it('recovers a residual segment alongside the parts', async () => {
			seedFiles(['Audio/rec-part1.webm', 'Audio/rec-part1.webm.tmp']);
			const session = rotationSession({
				partPaths: ['Audio/rec-part1.webm'],
				segmentPaths: ['Audio/rec-part1.webm.tmp'],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			expect(result.recoveredPaths).toEqual([
				'Audio/rec-part1.webm',
				'Audio/recording-Track1-stamp-recovered.webm',
			]);
			expect(binaryFiles.has('Audio/rec-part1.webm.tmp')).toBe(false);
		});

		it('leaves the auto-split parts of a stream session unreported', async () => {
			seedFiles(['Audio/rec-part1.webm', 'Audio/rec-part2.webm.tmp']);
			const session = streamSession({
				partPaths: ['Audio/rec-part1.webm'],
				segmentPaths: ['Audio/rec-part2.webm.tmp'],
			});
			storeJournal([session]);

			const result = await recoverSession(session, journal, mockApp);

			// A finished auto-split part is output the user already has; only
			// what recovery itself assembled is reported as recovered
			expect(result.recoveredPaths).toEqual([
				'Audio/recording-Track1-stamp-recovered.webm',
			]);
		});
	});

	describe('discardSession', () => {
		it('removes segments and clear the session', async () => {
			binaryFiles.set('Audio/rec-part1.webm.tmp', new ArrayBuffer(4));
			binaryFiles.set('Audio/rec-part2.webm.tmp', new ArrayBuffer(4));
			const session = createJournalSession({
				tracks: [
					createTrack({
						segmentPaths: [
							'Audio/rec-part1.webm.tmp',
							'Audio/rec-part2.webm.tmp',
						],
					}),
				],
			});
			storeJournal([session]);

			const failed = await discardSession(session, journal, mockApp);

			expect(failed).toEqual([]);
			expect(binaryFiles.size).toBe(0);
			expect(readStoredJournal()).toBeNull();
		});

		it('keeps paths that could not be removed journaled', async () => {
			binaryFiles.set('Audio/rec-part1.webm.tmp', new ArrayBuffer(4));
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const session = createJournalSession({
				tracks: [
					createTrack({
						segmentPaths: ['Audio/rec-part1.webm.tmp'],
					}),
				],
			});
			storeJournal([session]);

			const failed = await discardSession(session, journal, mockApp);

			expect(failed).toEqual(['Audio/rec-part1.webm.tmp']);
			expect(readStoredJournal()?.sessions).toHaveLength(1);
		});

		it('never touch finalized part files', async () => {
			binaryFiles.set('Audio/rec-part1.webm.tmp', new ArrayBuffer(4));
			binaryFiles.set('Audio/rec-part1.webm', new ArrayBuffer(100));
			const session = createJournalSession({
				tracks: [
					createTrack({
						segmentPaths: ['Audio/rec-part1.webm.tmp'],
						partPaths: ['Audio/rec-part1.webm'],
					}),
				],
			});
			storeJournal([session]);

			await discardSession(session, journal, mockApp);

			expect(binaryFiles.has('Audio/rec-part1.webm')).toBe(true);
		});

		it('removes the part files of a rotation session', async () => {
			seedFiles(TWO_PARTS);
			const session = rotationSession();
			storeJournal([session]);

			const failed = await discardSession(session, journal, mockApp);

			// Here the parts ARE the recording the user just turned down
			expect(failed).toEqual([]);
			expect(binaryFiles.size).toBe(0);
			expect(readStoredJournal()).toBeNull();
		});

		it('keeps a rotation part that could not be removed journaled', async () => {
			seedFiles(['Audio/rec-part1.webm']);
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const session = rotationSession({
				partPaths: ['Audio/rec-part1.webm'],
			});
			storeJournal([session]);

			const failed = await discardSession(session, journal, mockApp);

			expect(failed).toEqual(['Audio/rec-part1.webm']);
			expect(readStoredJournal()?.sessions).toHaveLength(1);
		});
	});
});
