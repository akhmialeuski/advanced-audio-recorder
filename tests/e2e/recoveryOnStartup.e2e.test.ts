/**
 * What the plugin offers when a recording died with the app.
 *
 * A crash, a power loss, or a plugin reload mid-recording leaves temporary
 * files behind and a journal entry describing them. Everything about what
 * happens next - whether the user is even asked, what recovering reports, what
 * discarding reports - lives in closures the plugin hands to the recovery
 * dialog, and none of them had ever run.
 * @module tests/e2e/recoveryOnStartup.e2e.test
 */

import AudioRecorderPlugin from 'src/main';
import { at } from '../helpers/assertions';
import { noticeMessages } from '../mocks/obsidian';
import { RecoveryModal } from 'src/ui/RecoveryModal';
import {
	collectRecoverableSessions,
	discardSession,
	recoverSession,
} from 'src/recording/RecoveryService';
import { loadPlugin } from '../helpers/pluginHarness';

jest.mock('src/ui/RecoveryModal', () => ({
	RecoveryModal: jest.fn().mockImplementation(() => ({ open: jest.fn() })),
}));

/** A journal entry describing a session that never finished. */
function interruptedSession(id: string): { id: string } {
	return { id };
}

/** Loads the plugin with the given interrupted sessions waiting for it. */
async function loadWithSessions(
	sessions: { id: string }[],
): Promise<AudioRecorderPlugin> {
	jest.mocked(collectRecoverableSessions).mockResolvedValue(
		sessions as never,
	);
	return (await loadPlugin()).plugin;
}

/** The choices the recovery dialog was opened with. */
function recoveryChoices(): {
	onRecover: () => Promise<void>;
	onDiscard: () => Promise<void>;
} {
	return at(jest.mocked(RecoveryModal).mock.calls, 0)[2];
}

describe('starting up after a clean shutdown', () => {
	it('asks nothing when no session was interrupted', async () => {
		await loadWithSessions([]);

		// Nothing to recover is the normal case; a dialog every launch would
		// be worse than useless.
		expect(RecoveryModal).not.toHaveBeenCalled();
	});
});

describe('starting up with an interrupted session', () => {
	it('offers to recover it', async () => {
		await loadWithSessions([interruptedSession('a')]);

		expect(RecoveryModal).toHaveBeenCalledTimes(1);
		const dialog = at(jest.mocked(RecoveryModal).mock.results, 0).value as {
			open: jest.Mock;
		};
		expect(dialog.open).toHaveBeenCalled();
	});

	it('carries on loading when the recovery check itself fails', async () => {
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		jest.mocked(collectRecoverableSessions).mockRejectedValue(
			new Error('journal unreadable'),
		);

		await expect(loadPlugin()).resolves.toBeDefined();
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('Recovery check failed'),
			expect.any(Error),
		);
	});
});

describe('recovering the interrupted session', () => {
	it('reports the files it brought back', async () => {
		await loadWithSessions([interruptedSession('a')]);
		jest.mocked(recoverSession).mockResolvedValue({
			recoveredPaths: ['Recordings/take.webm'],
			failedTracks: [],
		});

		await recoveryChoices().onRecover();

		expect(
			noticeMessages().some((message) =>
				message.includes('Recovered 1 audio file(s)'),
			),
		).toBe(true);
	});

	it('recovers every interrupted session, not only the first', async () => {
		await loadWithSessions([
			interruptedSession('a'),
			interruptedSession('b'),
		]);

		await recoveryChoices().onRecover();

		expect(recoverSession).toHaveBeenCalledTimes(2);
	});

	it('says which tracks it could not bring back, and that they were kept', async () => {
		await loadWithSessions([interruptedSession('a')]);
		jest.mocked(recoverSession).mockResolvedValue({
			recoveredPaths: [],
			failedTracks: ['track 2'],
		});

		await recoveryChoices().onRecover();

		// Keeping the temporary files is the point: a failed recovery must
		// leave something to try again with.
		expect(
			noticeMessages().some((message) =>
				message.includes('kept for the next attempt'),
			),
		).toBe(true);
	});

	it('says nothing at all when there was nothing to bring back', async () => {
		await loadWithSessions([interruptedSession('a')]);
		jest.mocked(recoverSession).mockResolvedValue({
			recoveredPaths: [],
			failedTracks: [],
		});

		await recoveryChoices().onRecover();

		expect(noticeMessages()).toHaveLength(0);
	});
});

describe('discarding the interrupted session', () => {
	it('confirms the temporary files are gone', async () => {
		await loadWithSessions([interruptedSession('a')]);
		jest.mocked(discardSession).mockResolvedValue([] as never);

		await recoveryChoices().onDiscard();

		expect(noticeMessages()).toContain(
			'Temporary recording files were discarded.',
		);
	});

	it('discards every interrupted session', async () => {
		await loadWithSessions([
			interruptedSession('a'),
			interruptedSession('b'),
		]);

		await recoveryChoices().onDiscard();

		expect(discardSession).toHaveBeenCalledTimes(2);
	});

	it('names the files it could not remove rather than claiming success', async () => {
		await loadWithSessions([interruptedSession('a')]);
		jest.mocked(discardSession).mockResolvedValue([
			'tmp/take.part1',
		] as never);

		await recoveryChoices().onDiscard();

		expect(
			noticeMessages().some((message) =>
				message.includes('tmp/take.part1'),
			),
		).toBe(true);
	});
});
