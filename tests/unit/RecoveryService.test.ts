/**
 * Unit tests for RecoveryService module.
 * Tests journal pruning, session recovery for both capture paths, and
 * discard semantics.
 * @module tests/unit/RecoveryService.test
 */
/** @jest-environment jsdom */

import {
	collectRecoverableSessions,
	recoverSession,
	discardSession,
} from '../../src/recording/RecoveryService';
import {
	SessionJournal,
	JOURNAL_VERSION,
} from '../../src/recording/SessionJournal';
import type {
	JournalFile,
	JournalSession,
	JournalTrack,
} from '../../src/recording/SessionJournal';
import type { App } from 'obsidian';

jest.mock('obsidian', () => ({
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

jest.mock('../../src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest.fn((segmentPaths: string[]) =>
		Promise.resolve(new Uint8Array(44 + segmentPaths.length).buffer),
	),
}));

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

describe('RecoveryService', () => {
	/** In-memory text file store (journal). */
	let textFiles: Map<string, string>;
	/** In-memory binary file store (segments and recovered audio). */
	let binaryFiles: Map<string, ArrayBuffer>;
	let journal: SessionJournal;
	let mockApp: App;
	let consoleWarnSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;

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

	const readStoredJournal = (): JournalFile | null => {
		const raw = textFiles.get(JOURNAL_PATH);
		return raw ? (JSON.parse(raw) as JournalFile) : null;
	};

	beforeEach(() => {
		jest.clearAllMocks();
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		textFiles = new Map();
		binaryFiles = new Map();
		mockApp = {
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
		} as unknown as App;
		journal = new SessionJournal(JOURNAL_PATH, mockApp);
	});

	afterEach(() => {
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	describe('collectRecoverableSessions', () => {
		it('should return nothing when no journal exists', async () => {
			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
		});

		it('should delete a corrupt journal without prompting', async () => {
			textFiles.set(JOURNAL_PATH, '{not json');

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(false);
		});

		it('should leave a newer-version journal untouched', async () => {
			storeJournal([createJournalSession()], JOURNAL_VERSION + 1);

			const sessions = await collectRecoverableSessions(journal, mockApp);

			expect(sessions).toEqual([]);
			expect(textFiles.has(JOURNAL_PATH)).toBe(true);
		});

		it('should prune missing segments and self-clear empty sessions', async () => {
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

		it('should keep sessions with surviving segments', async () => {
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
			expect(sessions[0].tracks[0].segmentPaths).toEqual([
				'Audio/rec-part1.webm.tmp',
			]);
		});

		it('should mark media tracks whose first segment is gone as header-lost', async () => {
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

			expect(sessions[0].tracks[0].headerLost).toBe(true);
		});
	});

	describe('recoverSession', () => {
		it('should reassemble PCM tracks into a recovered WAV next to the segments', async () => {
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

			const { assembleWavFromPcmSegmentFiles } = jest.requireMock(
				'../../src/audio/WavEncoder',
			);
			// Streamed straight from the segment files: recovery must not
			// read the whole track into memory before assembly
			expect(assembleWavFromPcmSegmentFiles).toHaveBeenCalledWith(
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

		it('should byte-concatenate media tracks in capture order', async () => {
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

		it('should report header-lost media tracks as failed and keep them journaled', async () => {
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

		it('should resolve name collisions with a counter suffix', async () => {
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

		it('should isolate per-track failures', async () => {
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
			expect(readStoredJournal()?.sessions[0].tracks).toHaveLength(1);
			expect(
				readStoredJournal()?.sessions[0].tracks[0].fileBaseName,
			).toBe('bad-track');
		});
	});

	describe('discardSession', () => {
		it('should remove segments and clear the session', async () => {
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

		it('should keep paths that could not be removed journaled', async () => {
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

		it('should never touch finalized part files', async () => {
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
	});
});
