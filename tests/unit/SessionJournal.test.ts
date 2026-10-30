/**
 * Unit tests for SessionJournal module.
 * Tests journal persistence, write coalescing, and failure tolerance.
 * @module tests/unit/SessionJournal.test
 */

import { SessionJournal, JOURNAL_VERSION } from 'src/recording/SessionJournal';
import { at } from '../helpers/assertions';
import type { JournalFile, JournalSession } from 'src/recording/SessionJournal';
import type { App } from 'obsidian';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';

const JOURNAL_PATH = '.obsidian/plugins/aar/recording-journal.json';

/** The id of the session most cases journal. */
const SESSION_ID = '2026-06-12T10-00-00-000Z';

const createSession = (
	overrides: Partial<JournalSession> = {},
): JournalSession => ({
	sessionId: SESSION_ID,
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

		const vault = fakeVaultFiles();
		files = vault.files;
		writeMock = vault.adapter.write;
		mockApp = createMockApp({ vault: { adapter: vault.adapter } }).app;
		journal = new SessionJournal(JOURNAL_PATH, mockApp);
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
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.webm.tmp',
			);
			journal.addSegment(
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part2.webm.tmp',
			);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).segmentPaths,
			).toEqual(['rec-part1.webm.tmp', 'rec-part2.webm.tmp']);

			journal.removeSegments(SESSION_ID, ['rec-part1.webm.tmp']);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).segmentPaths,
			).toEqual(['rec-part2.webm.tmp']);
		});

		it('records part files', async () => {
			journal.startSession(createSession());
			journal.addPart(
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.webm',
			);
			await journal.flush();

			expect(
				at(at(readStoredJournal().sessions, 0).tracks, 0).partPaths,
			).toEqual(['rec-part1.webm']);
		});

		it('records the length a part put safely on disk', async () => {
			journal.startSession(createSession());
			journal.addPart(
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.webm',
				900_000,
			);
			await journal.flush();

			// What the recovery dialog offers the user as the length of an
			// interrupted session
			expect(at(readStoredJournal().sessions, 0).recordedMs).toBe(
				900_000,
			);
		});

		it('leaves the length unset where the caller keeps no clock', async () => {
			journal.startSession(createSession());
			journal.addPart(
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'rec-part1.wav',
			);
			await journal.flush();

			expect(
				at(readStoredJournal().sessions, 0).recordedMs,
			).toBeUndefined();
		});

		it('removes the file when the last session ends', async () => {
			journal.startSession(createSession());
			await journal.flush();
			expect(files.has(JOURNAL_PATH)).toBe(true);

			journal.endSession(SESSION_ID);
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

		it('ignores segment updates for a session that is not open', async () => {
			journal.addSegment(SESSION_ID, 'some-track', 'seg.tmp');
			await journal.flush();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});
	});

	// A stop hands its session to the save queue and the next recording opens
	// its own while the first is written, so two sessions are open at once.
	describe('two sessions open at once', () => {
		/** The session a stop handed to the save queue. */
		const saving = (): JournalSession =>
			createSession({
				sessionId: 'saving-session',
				tracks: [
					{
						fileBaseName: 'recording-Track1-saving',
						isPcm: false,
						pcmChannels: 1,
						pcmSampleRate: 44100,
						segmentPaths: [
							'old-part1.webm.tmp',
							'old-part2.webm.tmp',
						],
						partPaths: [],
					},
				],
			});
		/** The session recording meanwhile. */
		const capturing = (): JournalSession =>
			createSession({
				sessionId: 'capturing-session',
				tracks: [
					{
						fileBaseName: 'recording-Track1-capturing',
						isPcm: false,
						pcmChannels: 1,
						pcmSampleRate: 44100,
						segmentPaths: [],
						partPaths: [],
					},
				],
			});

		/** The stored session of one id. */
		const stored = (sessionId: string): JournalSession | undefined =>
			readStoredJournal().sessions.find(
				(session) => session.sessionId === sessionId,
			);

		beforeEach(() => {
			journal.startSession(saving());
			journal.startSession(capturing());
		});

		it('writes a segment to the session it is addressed to', async () => {
			journal.addSegment(
				'capturing-session',
				'recording-Track1-capturing',
				'new-part1.webm.tmp',
			);
			journal.addPart(
				'capturing-session',
				'recording-Track1-capturing',
				'new-part1.webm',
				60_000,
			);
			await journal.flush();

			expect(
				stored('capturing-session')?.tracks[0]?.segmentPaths,
			).toEqual(['new-part1.webm.tmp']);
			expect(stored('capturing-session')?.recordedMs).toBe(60_000);
			expect(stored('saving-session')?.recordedMs).toBeUndefined();
		});

		it("strikes one session's segments without touching the other's", async () => {
			journal.addSegment(
				'capturing-session',
				'recording-Track1-capturing',
				'new-part1.webm.tmp',
			);
			journal.removeSegments('saving-session', [
				'old-part1.webm.tmp',
				'new-part1.webm.tmp',
			]);
			await journal.flush();

			expect(stored('saving-session')?.tracks[0]?.segmentPaths).toEqual([
				'old-part2.webm.tmp',
			]);
			expect(
				stored('capturing-session')?.tracks[0]?.segmentPaths,
			).toEqual(['new-part1.webm.tmp']);
		});

		it('ends one session and keeps the other open', async () => {
			journal.endSession('saving-session');
			journal.addSegment(
				'saving-session',
				'recording-Track1-saving',
				'late.webm.tmp',
			);
			await journal.flush();

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['capturing-session']);
		});

		// The startup recovery deletes a journal it cannot parse, and a session
		// started meanwhile loses its entry with it. Its later writes have
		// nothing to land in and are dropped rather than recreating a stub.
		it('drops a write for an open session whose entry was discarded', async () => {
			await journal.flush();
			await journal.discardJournalFile();

			journal.addSegment(
				'capturing-session',
				'recording-Track1-capturing',
				'new-part1.webm.tmp',
			);
			await journal.flush();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});

		it('keeps every open session when recovery replaces the rest', async () => {
			await journal.replaceSessions([
				createSession({ sessionId: 'crashed-session' }),
			]);

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual([
				'crashed-session',
				'saving-session',
				'capturing-session',
			]);
		});
	});

	describe('write coalescing and failure tolerance', () => {
		it('coalesces synchronous mutations into one write', async () => {
			journal.startSession(createSession());
			journal.addSegment(
				SESSION_ID,
				'recording-Track1-2026-06-12T10-00-00-000Z',
				'a.tmp',
			);
			journal.addSegment(
				SESSION_ID,
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

			journal.endSession(SESSION_ID);
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

	// The journal is read at startup to offer crash recovery, so a file that
	// is not a journal must read as "nothing to recover" rather than as a
	// session whose fields are all undefined.
	describe('a journal file that is not one', () => {
		it.each([
			{ name: 'a JSON string', body: '"hello"' },
			{ name: 'a JSON array', body: '[]' },
			{ name: 'null', body: 'null' },
			{ name: 'no version', body: JSON.stringify({ sessions: [] }) },
			{
				name: 'a version that is not a number',
				body: JSON.stringify({ version: 'one', sessions: [] }),
			},
			{
				name: 'sessions that are not a list',
				body: JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: {},
				}),
			},
			{
				name: 'a session that is not an object',
				body: JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: ['nope'],
				}),
			},
			{
				name: 'a session with no id',
				body: JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: [{ tracks: [] }],
				}),
			},
			{
				name: 'a session whose tracks are not a list',
				body: JSON.stringify({
					version: JOURNAL_VERSION,
					sessions: [{ sessionId: 'x', tracks: 'nope' }],
				}),
			},
		])('reads $name as corrupt', async ({ body }) => {
			files.set(JOURNAL_PATH, body);

			expect(await journal.readJournal()).toEqual({
				data: null,
				corrupt: true,
			});
		});

		// A mutation is not a recovery check: it starts a fresh journal over
		// the unusable one rather than refusing to record.
		it('starts a fresh journal when a session begins over an unusable one', async () => {
			files.set(JOURNAL_PATH, JSON.stringify({ foo: 'bar' }));

			journal.startSession(createSession({ sessionId: 'fresh' }));
			await journal.flush();

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['fresh']);
		});

		it('starts a fresh journal when the file cannot be read at all', async () => {
			files.set(
				JOURNAL_PATH,
				JSON.stringify({ version: JOURNAL_VERSION, sessions: [] }),
			);
			jest.mocked(mockApp.vault.adapter.read).mockRejectedValueOnce(
				new Error('locked'),
			);

			journal.startSession(createSession({ sessionId: 'fresh' }));
			await journal.flush();

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to load the recording journal'),
				expect.any(Error),
			);
			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['fresh']);
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

		// The recovery scan reads the journal, then writes back what is left
		// after the user's choice. A session that started recording in that
		// window is in both lists, and must end up in the file once.
		it('keeps the active session once when the replacement also names it', async () => {
			journal.startSession(createSession({ sessionId: 'active' }));
			await journal.flush();

			await journal.replaceSessions([
				createSession({ sessionId: 'active' }),
				createSession({ sessionId: 'old' }),
			]);

			expect(
				readStoredJournal().sessions.map((s) => s.sessionId),
			).toEqual(['old', 'active']);
		});
	});

	describe('discardJournalFile', () => {
		it('removes the journal file', async () => {
			files.set(JOURNAL_PATH, '{not json');

			await journal.discardJournalFile();

			expect(files.has(JOURNAL_PATH)).toBe(false);
		});

		// Discarding runs from the recovery prompt, which the user answered:
		// a vault that refuses the delete is logged, not thrown at them.
		it('reports a file it could not remove instead of throwing', async () => {
			files.set(JOURNAL_PATH, '{not json');
			jest.mocked(mockApp.vault.adapter.remove).mockRejectedValueOnce(
				new Error('the vault is read-only'),
			);

			await expect(journal.discardJournalFile()).resolves.toBeUndefined();

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Failed to remove the recording journal',
				),
				expect.any(Error),
			);
		});

		it('does nothing where no journal is kept at all', async () => {
			await new SessionJournal(null, mockApp).discardJournalFile();

			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});
	});

	// flush() is called on every stop and again on unload; writing a journal
	// that has not changed would rewrite the file for nothing.
	describe('flushing with nothing to write', () => {
		it('writes once for a flush repeated with no change between', async () => {
			journal.startSession(createSession());
			await journal.flush();
			const writesAfterFirst = writeMock.mock.calls.length;

			await journal.flush();

			expect(writeMock.mock.calls).toHaveLength(writesAfterFirst);
		});
	});

	describe('null journal path', () => {
		it('noes-op every operation', async () => {
			const nullJournal = new SessionJournal(null, mockApp);

			nullJournal.startSession(createSession());
			nullJournal.addSegment(SESSION_ID, 'track', 'seg.tmp');
			nullJournal.endSession(SESSION_ID);
			await nullJournal.flush();

			expect(writeMock).not.toHaveBeenCalled();
			expect(await nullJournal.readJournal()).toEqual({
				data: null,
				corrupt: false,
			});
		});
	});
});
