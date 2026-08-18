/**
 * Unit tests for RecoveryModal module.
 * @module tests/unit/RecoveryModal.test
 */

import { RecoveryModal } from 'src/ui/RecoveryModal';
import { at } from '../helpers/assertions';
import type { JournalSession } from 'src/recording/SessionJournal';
import { App, Notice } from 'obsidian';
// The full obsidian mock with only Setting swapped for the recording double,
// which is what makes the dialog's buttons reachable by label.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);
import { capturedSettings } from '../helpers/captureSettings';
import { el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';

/** Captured action buttons rendered by the modal. */

const createSession = (
	overrides: Partial<JournalSession> = {},
): JournalSession => ({
	sessionId: 'session-1',
	startedAt: 1765533600000,
	outputFormat: 'webm',
	recorderFormat: 'webm',
	bitrate: 128000,
	tracks: [
		{
			fileBaseName: 'recording-Track1-stamp',
			isPcm: false,
			pcmChannels: 1,
			pcmSampleRate: 44100,
			segmentPaths: ['a.tmp', 'b.tmp'],
			partPaths: ['part1.webm'],
		},
	],
	...overrides,
});

describe('RecoveryModal', () => {
	let onRecover: jest.Mock;
	let onDiscard: jest.Mock;

	const openModal = (sessions: JournalSession[]): RecoveryModal => {
		const modal = new RecoveryModal(new App(), sessions, {
			onRecover,
			onDiscard,
		});
		// The dialog closes itself when a choice is made; watch that here since
		// the shared Modal's close is a plain method.
		jest.spyOn(modal, 'close');
		modal.onOpen();
		return modal;
	};

	/**
	 * Presses the dialog button with the given label.
	 * @param text - Exact button text
	 */
	const clickButton = (text: string): void => {
		const button = capturedSettings
			.flatMap((row) => row.buttons)
			.find((entry) => entry.label === text);
		if (!button) {
			throw new Error(`Button "${text}" not rendered`);
		}
		button.click();
	};

	beforeEach(() => {
		capturedSettings.length = 0;
		onRecover = jest.fn().mockResolvedValue(undefined);
		onDiscard = jest.fn().mockResolvedValue(undefined);
	});

	it('renders session details with the saved-parts note', () => {
		const modal = openModal([createSession()]);

		const line = el(modal.contentEl, MODAL.recoverySession);
		expect(line.textContent).toContain('1 track(s)');
		expect(line.textContent).toContain('2 temporary segment(s)');
		expect(line.textContent).toContain('1 already saved part file(s)');
	});

	it('omits the parts note when no parts were saved', () => {
		const session = createSession();
		at(session.tracks, 0).partPaths = [];
		const modal = openModal([session]);

		expect(
			el(modal.contentEl, MODAL.recoverySession).textContent,
		).not.toContain('already saved part');
	});

	it('runs the recover callback and close', async () => {
		const modal = openModal([createSession()]);

		clickButton('Recover audio');
		await Promise.resolve();

		expect(onRecover).toHaveBeenCalledTimes(1);
		expect(onDiscard).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('runs the discard callback and close', async () => {
		const modal = openModal([createSession()]);

		clickButton('Discard');
		await Promise.resolve();

		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(onRecover).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('closes without callbacks on decide later', () => {
		const modal = openModal([createSession()]);

		clickButton('Decide later');

		expect(onRecover).not.toHaveBeenCalled();
		expect(onDiscard).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('ignores a second click while an action runs', async () => {
		let release: () => void = () => undefined;
		onRecover.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		openModal([createSession()]);

		clickButton('Recover audio');
		clickButton('Recover audio');
		release();
		await Promise.resolve();

		expect(onRecover).toHaveBeenCalledTimes(1);
	});

	it('contains a failing action, notify, and still close', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation();
		onRecover.mockRejectedValue(new Error('vault unavailable'));
		const modal = openModal([createSession()]);

		clickButton('Recover audio');
		// Drain the rejected action and the catch/finally microtasks
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// The click handler fires-and-forgets the action: a rejection
		// must be contained here, not surface as an unhandled rejection
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Recovery action failed'),
			expect.objectContaining({ message: 'vault unavailable' }),
		);
		expect(Notice).toHaveBeenCalledWith(
			'The recovery action failed. Check the console for details.',
		);
		expect(modal.close).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('accepts a new action after a failed one', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation();
		onRecover.mockRejectedValue(new Error('vault unavailable'));
		openModal([createSession()]);

		clickButton('Recover audio');
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		clickButton('Discard');
		await Promise.resolve();

		expect(onDiscard).toHaveBeenCalledTimes(1);
		errorSpy.mockRestore();
	});
});
