/**
 * Unit tests for RecoveryModal module.
 * @module tests/unit/RecoveryModal.test
 */
/** @jest-environment jsdom */

import { RecoveryModal } from '../../src/ui/RecoveryModal';
import type { JournalSession } from '../../src/recording/SessionJournal';
import { App } from 'obsidian';

/** Captured action buttons rendered by the modal. */
const renderedButtons: { text: string; onClick: () => void }[] = [];

jest.mock('obsidian', () => ({
	App: jest.fn(),
	Modal: class {
		app: unknown;
		contentEl: HTMLElement;
		constructor(app: unknown) {
			this.app = app;
			const el = document.createElement('div');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
			(el as any).empty = function () {
				while (this.firstChild) {
					this.removeChild(this.firstChild);
				}
			};
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
			(el as any).createEl = function (
				tag: string,
				opts?: { text?: string; cls?: string },
			) {
				const child = document.createElement(tag);
				if (opts?.text) child.textContent = opts.text;
				if (opts?.cls) child.className = opts.cls;
				this.appendChild(child);
				return child;
			};
			this.contentEl = el;
		}
		open = jest.fn();
		close = jest.fn();
	},
	Notice: jest.fn(),
	Setting: class {
		setName(): this {
			return this;
		}
		setHeading(): this {
			return this;
		}
		addButton(
			callback: (button: {
				setButtonText: (text: string) => unknown;
				setCta: () => unknown;
				onClick: (handler: () => void) => unknown;
			}) => void,
		): this {
			let label = '';
			const button = {
				setButtonText(text: string) {
					label = text;
					return this;
				},
				setCta() {
					return this;
				},
				onClick(handler: () => void) {
					renderedButtons.push({ text: label, onClick: handler });
					return this;
				},
			};
			callback(button);
			return this;
		}
	},
}));

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
		modal.onOpen();
		return modal;
	};

	const clickButton = (text: string): void => {
		const button = renderedButtons.find((entry) => entry.text === text);
		if (!button) {
			throw new Error(`Button "${text}" not rendered`);
		}
		button.onClick();
	};

	beforeEach(() => {
		jest.clearAllMocks();
		renderedButtons.length = 0;
		onRecover = jest.fn().mockResolvedValue(undefined);
		onDiscard = jest.fn().mockResolvedValue(undefined);
	});

	it('should render session details with the saved-parts note', () => {
		const modal = openModal([createSession()]);

		const line = modal.contentEl.querySelector('.aar-recovery-session');
		expect(line?.textContent).toContain('1 track(s)');
		expect(line?.textContent).toContain('2 temporary segment(s)');
		expect(line?.textContent).toContain('1 already saved part file(s)');
	});

	it('should omit the parts note when no parts were saved', () => {
		const session = createSession();
		session.tracks[0].partPaths = [];
		const modal = openModal([session]);

		const line = modal.contentEl.querySelector('.aar-recovery-session');
		expect(line?.textContent).not.toContain('already saved part');
	});

	it('should run the recover callback and close', async () => {
		const modal = openModal([createSession()]);

		clickButton('Recover audio');
		await Promise.resolve();

		expect(onRecover).toHaveBeenCalledTimes(1);
		expect(onDiscard).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('should run the discard callback and close', async () => {
		const modal = openModal([createSession()]);

		clickButton('Discard');
		await Promise.resolve();

		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(onRecover).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('should close without callbacks on decide later', () => {
		const modal = openModal([createSession()]);

		clickButton('Decide later');

		expect(onRecover).not.toHaveBeenCalled();
		expect(onDiscard).not.toHaveBeenCalled();
		expect(modal.close).toHaveBeenCalled();
	});

	it('should ignore a second click while an action runs', async () => {
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

	it('should contain a failing action, notify, and still close', async () => {
		const { Notice } = jest.requireMock('obsidian');
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

	it('should accept a new action after a failed one', async () => {
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
