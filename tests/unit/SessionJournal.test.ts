/**
 * Unit tests for SessionJournal module.
 * Tests journal persistence, write coalescing, and failure tolerance.
 * @module tests/unit/SessionJournal.test
 */

import { SessionJournal, JOURNAL_VERSION } from 'src/recording/SessionJournal';
import { at } from '../helpers/assertions';
import type { JournalFile, JournalSession } from 'src/recording/SessionJournal';
import type { App } from 'obsidian';
import { partialApp } from '../helpers/obsidianMock';

const JOURNAL_PATH = '.obsidian/plugins/aar/recording-journal.json';

const createSession = (
	overrides: Partial<JournalSession> = {},
): JournalSession => ({
	sessionId: '2026-06-12T10-00-00-000Z',
	startedAt: 1765533600000,
	outputFormat: 'webm',
	recorderFormat: 'webm',
	bitrate: 128000,
	tracks: [
		{
			fileBaseName: 'recording-Track1-2026-06-12T10-00-00-000Z',
			isPcm: false,
			pcmChannels: 1,
			pcmSampleRate: 44100,
			segmentPaths: [],
			partPaths: [],
		},
	],
	...overrides,
});

describe('SessionJournal', () => {
	/** In-memory file store backing the adapter mock. */
	let files: Map<string, string>;
	let journal: SessionJournal;
	let mockApp: App;
	let writeMock: jest.Mock;
	let consoleWarnSpy: jest.SpyInstance;

	const readStoredJournal = (): JournalFile =>
		JSON.parse(files.get(JOURNAL_PATH) ?? 'null') as JournalFile;

	beforeEach(() => {
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

		files = new Map();
		writeMock = jest.fn((path: string, data: string) => {
			files.set(path, data);
			return Promise.resolve();
		});
		mockApp = partialApp({
			vault: {
				adapter: {
					exists: jest.fn((path: string) =>
						Promise.resolve(files.has(path)),
					),
					read: jest.fn((path: string) => {
						const content = files.get(path);
						return content !== undefined
							? Promise.resolve(content)
							: Promise.reject(new Error('missing'));
					}),
					write: writeMock,
					remove: jest.fn((path: string) => {
						files.delete(path);
						return Promise.resolve();
					}),
				},
			},
		});
		journal = new SessionJournal(JOURNAL_PATH, mockApp);
	});

	afterEach(() => {
		consoleWarnSpy.mockRestore();
	});

	describe('session lifecycle', () => {
		it('writes the journal with the started session', async () => {
			journal.startSession(createSession());
			await journal.flush();

			const stored = readStoredJournal();
			expect(stored.version).toBe(JOURNAL_VERSION);
			expect(stored.sessions).toHaveLength(1);
			expect(at(stored.sessions, 0).sessionId).toBe(
				'2026-06-12T10-00-00-000Z',
			);
		});

		it('tracks added and removed segments', async () => {
			journal.startSession(createSession());
			journal.addSegment(
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.webm.tmp',
			);
			journal.addSegment(
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part2.webm.tmp',
			);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).segmentPaths,
			).toEqual(['rec-part1.webm.tmp', 'rec-part2.webm.tmp']);

			journal.removeSegments(['rec-part1.webm.tmp']);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).segmentPaths,
			).toEqual(['rec-part2.webm.tmp']);
		});

		it('records part files', async () => {
			journal.startSession(createSession());
			journal.addPart(
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.webm',
			);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).partPaths,
			).toEqual(['rec-part1.webm']);
		});

		it('removes the file when the last session ends', async () => {
			journal.startSession(createSession());
			await journal.flush();
			expect(files.has(JOURNAL_PATH)).toBe(true);

			journal.endSession();
			await journal.flush();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});

		it('appends a second session without clobbering the first', async () => {
			files.set(
				JOURNAL_PATH,
				JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: [createSession({ sessionId: 'crashed-session' })],
				}),
			);

			journal.startSession(createSession({ sessionId: 'new-session' }));
			await journal.flush();

			const stored = readStoredJournal();
			expect(stored.sessions.map((s) => s.sessionId)).toEqual([
				'crashed-session',
				'new-session',
			]);
		});

		it('ignores segment updates without an active session', async () => {
			journal.addSegment('some-track', 'seg.tmp');
			await journal.flush();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});
	});

	describe('write coalescing and failure tolerance', () => {
		it('coalesces synchronous mutations into one write', async () => {
			journal.startSession(createSession());
			journal.addSegment(
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'a.tmp',
			);
			journal.addSegment(
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'b.tmp',
			);
			await journal.flush();

			expect(writeMock).toHaveBeenCalledTimes(1);
			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).segmentPaths,
			).toEqual(['a.tmp', 'b.tmp']);
		});

		it('swallows write failures without rejecting', async () => {
			writeMock.mockRejectedValueOnce(new Error('disk full'));

			journal.startSession(createSession());
			await expect(journal.flush()).resolves.toBeUndefined();

			expect(consoleWarnSpy).toHaveBeenCalled();
		});

		it('falls back to an empty journal write when removal fails', async () => {
			jest.mocked(mockApp.vault.adapter.remove).mockRejectedValue(
				new Error('locked'),
			);
			journal.startSession(createSession());
			await journal.flush();

			journal.endSession();
			await journal.flush();

			expect(readStoredJournal().sessions).toEqual([]);
		});
	});

	describe('readJournal', () => {
		it('reports a missing file as no data', async () => {
			const result = await journal.readJournal();

			expect(result).toEqual({ data: null, corrupt: false });
		});

		it('rounds-trip a valid journal', async () => {
			journal.startSession(createSession());
			await journal.flush();

			const result = await journal.readJournal();

			expect(result.corrupt).toBe(false);
			expect(result.data?.sessions).toHaveLength(1);
		});

		it('flags unparseable content as corrupt', async () => {
			files.set(JOURNAL_PATH, '{not json');

			const result = await journal.readJournal();

			expect(result).toEqual({ data: null, corrupt: true });
		});

		it('flags structurally invalid content as corrupt', async () => {
			files.set(JOURNAL_PATH, JSON.stringify({ foo: 'bar' }));

			const result = await journal.readJournal();

			expect(result).toEqual({ data: null, corrupt: true });
		});

		it('keeps the file on a transient read failure', async () => {
			files.set(
				JOURNAL_PATH,
				JSON.stringify({ version: JOURNAL_VERSION, sessions: [] }),
			);
			jest.mocked(mockApp.vault.adapter.read).mockRejectedValueOnce(
				new Error('locked'),
			);

			const result = await journal.readJournal();

			expect(result).toEqual({ data: null, corrupt: false });
			expect(files.has(JOURNAL_PATH)).toBe(true);
		});
	});

	describe('replaceSessions', () => {
		it('rewrites non-active sessions', async () => {
			files.set(
				JOURNAL_PATH,
				JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: [
						createSession({ sessionId: 'old-1' }),
						createSession({ sessionId: 'old-2' }),
					],
				}),
			);

			await journal.replaceSessions([
				createSession({ sessionId: 'old-2' }),
			]);

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['old-2']);
		});

		it('keeps the active session through a replace', async () => {
			journal.startSession(createSession({ sessionId: 'active' }));
			await journal.flush();

			await journal.replaceSessions([]);

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['active']);
		});
	});

	describe('discardJournalFile', () => {
		it('removes the journal file', async () => {
			files.set(JOURNAL_PATH, '{not json');

			await journal.discardJournalFile();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});
	});

	describe('null journal path', () => {
		it('noes-op every operation', async () => {
			const nullJournal = new SessionJournal(null, mockApp);

			nullJournal.startSession(createSession());
			nullJournal.addSegment('track', 'seg.tmp');
			nullJournal.endSession();
			await nullJournal.flush();

			expect(writeMock).not.toHaveBeenCalled();
			expect(await nullJournal.readJournal()).toEqual({
				data: null,
				corrupt: false,
			});
		});
	});
});
