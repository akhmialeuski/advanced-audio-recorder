/**
 * Tests for the queue dialog: what it says a folder will cost before it runs,
 * what each recording is doing while it does, and the controls over it.
 * @jest-environment jsdom
 */

import { App } from 'obsidian';
import { TranscriptionQueueModal } from 'src/ui/TranscriptionQueueModal';
import { TranscriptionQueue } from 'src/transcription/TranscriptionQueue';
import { createMockApp } from '../helpers/createApp';
import { allEls, el, textsOf } from '../helpers/dom';
import { QUEUE } from '../helpers/selectors';
import { at } from '../helpers/assertions';

interface Sut {
	modal: TranscriptionQueueModal;
	queue: TranscriptionQueue;
	started: jest.Mock;
}

/**
 * Opens the dialog over a queue of the given recordings.
 * @param options - What this case varies
 * @returns The open dialog, its queue, and whether it started anything
 */
function createSut(
	options: {
		paths?: string[];
		running?: boolean;
		estimatedUsd?: number | null;
		hasUnpriced?: boolean;
	} = {},
): Sut {
	const app = createMockApp().app;
	const queue = new TranscriptionQueue(null, app);
	queue.add(options.paths ?? ['Recordings/a.webm', 'Recordings/b.webm']);
	const started = jest.fn();
	const modal = new TranscriptionQueueModal(new App(), {
		queue,
		estimatedUsd:
			options.estimatedUsd === undefined ? 0.5 : options.estimatedUsd,
		hasUnpriced: options.hasUnpriced ?? false,
		onStart: started,
		isRunning: () => options.running ?? false,
	});
	modal.onOpen();
	return { modal, queue, started };
}

describe('what the queue dialog says it will cost', () => {
	it('names how many recordings and what they come to', () => {
		const { modal } = createSut();

		expect(el(modal.contentEl, QUEUE.cost).textContent).toBe(
			'2 recordings, about $0.50.',
		);
	});

	it('leaves out the recordings that have already run', () => {
		// Reopening a drained queue used to quote the whole folder again: the
		// count came from every entry it held, so work that was finished and
		// paid for was named as a spend about to happen.
		const { modal, queue } = createSut({
			paths: ['a.webm', 'b.webm', 'c.webm'],
		});
		queue.setState('a.webm', 'done');
		queue.setState('b.webm', 'failed');
		modal.contentEl.empty();
		modal.onOpen();

		expect(el(modal.contentEl, QUEUE.cost).textContent).toContain(
			'1 recording,',
		);
	});

	it('counts one recording in the singular', () => {
		const { modal } = createSut({ paths: ['a.webm'] });

		expect(el(modal.contentEl, QUEUE.cost).textContent).toContain(
			'1 recording,',
		);
	});

	it('says so when the model has no built-in rate', () => {
		const { modal } = createSut({ estimatedUsd: null });

		expect(el(modal.contentEl, QUEUE.cost).textContent).toContain(
			'no built-in rate',
		);
	});

	it('says when part of the run could not be priced', () => {
		const { modal } = createSut({ hasUnpriced: true });

		expect(el(modal.contentEl, QUEUE.cost).textContent).toContain(
			'could not be priced',
		);
	});
});

describe('what the queue dialog shows', () => {
	it('names each recording, without the folder it sits in', () => {
		const { modal } = createSut();

		expect(allEls(modal.contentEl, QUEUE.row)).toHaveLength(2);
		expect(modal.contentEl.textContent).toContain('a.webm');
		expect(modal.contentEl.textContent).not.toContain('Recordings/a.webm');
	});

	it.each([
		{ state: 'waiting' as const, shown: 'Waiting' },
		{ state: 'running' as const, shown: 'Transcribing' },
		{ state: 'done' as const, shown: 'Done' },
		{ state: 'failed' as const, shown: 'Failed' },
	])('says a $state recording is $shown', ({ state, shown }) => {
		const { modal, queue } = createSut({ paths: ['a.webm'] });

		queue.setState('a.webm', state);

		expect(at(textsOf(modal.contentEl, QUEUE.state), 0)).toBe(shown);
	});

	it('says why a recording failed, so the row is worth acting on', () => {
		const { modal, queue } = createSut({ paths: ['a.webm'] });

		queue.setState('a.webm', 'failed', 'no API key');

		expect(at(textsOf(modal.contentEl, QUEUE.state), 0)).toBe(
			'Failed: no API key',
		);
	});

	it('redraws itself when the queue moves under it', () => {
		const { modal, queue } = createSut({ paths: ['a.webm'] });

		queue.add(['b.webm']);

		expect(allEls(modal.contentEl, QUEUE.row)).toHaveLength(2);
	});

	it('stops redrawing once the dialog is closed', () => {
		const { modal, queue } = createSut({ paths: ['a.webm'] });
		modal.onClose();

		queue.add(['b.webm']);

		expect(allEls(modal.contentEl, QUEUE.row)).toHaveLength(0);
	});
});

describe('the controls over a queue', () => {
	/**
	 * Presses the dialog button with the given label. Dialog buttons carry
	 * their label as text, not as an accessible name, so they are found the
	 * way the other dialog tests find them.
	 * @param modal - The open dialog
	 * @param text - The button's label
	 */
	function press(modal: TranscriptionQueueModal, text: string): void {
		const button = Array.from(
			modal.contentEl.querySelectorAll('button'),
		).find((candidate) => candidate.textContent === text);
		if (!button) {
			throw new Error(`The dialog offers no ${text} button`);
		}
		button.click();
	}

	it('starts the queue and steps out of the way', () => {
		const { modal, started } = createSut();

		press(modal, 'Start');

		expect(started).toHaveBeenCalledTimes(1);
	});

	it('empties the queue when the run is called off', () => {
		const { modal, queue, started } = createSut();

		press(modal, 'Discard queue');

		expect(queue.entries()).toEqual([]);
		expect(started).not.toHaveBeenCalled();
	});

	// The dialog is reachable from the command palette at any time, so
	// dismissing it is not a statement about the work in it. Emptying the
	// queue on the way out cost a user the folder they had queued the night
	// before and opened the dialog only to look at.
	it('leaves the queue alone when the dialog is merely closed', () => {
		const { modal, queue, started } = createSut();

		press(modal, 'Close');

		expect(queue.entries().map((entry) => entry.path)).toEqual([
			'Recordings/a.webm',
			'Recordings/b.webm',
		]);
		expect(started).not.toHaveBeenCalled();
	});

	it('drops one recording without touching the rest', () => {
		const { modal, queue } = createSut();

		el(modal.contentEl, QUEUE.remove).click();

		expect(queue.entries().map((e) => e.path)).toEqual([
			'Recordings/b.webm',
		]);
	});

	it('offers no drop for the recording in flight', () => {
		const { modal, queue } = createSut({ paths: ['a.webm'] });

		queue.setState('a.webm', 'running');

		expect(allEls(modal.contentEl, QUEUE.remove)).toHaveLength(0);
	});

	it('offers to pause a queue that is already running', () => {
		const { modal, queue } = createSut({ running: true });

		press(modal, 'Pause');

		expect(queue.isPaused()).toBe(true);
	});

	it('offers to resume a paused queue, and starts it again', () => {
		const app = createMockApp().app;
		const queue = new TranscriptionQueue(null, app);
		queue.add(['a.webm']);
		queue.setPaused(true);
		const started = jest.fn();
		const modal = new TranscriptionQueueModal(new App(), {
			queue,
			estimatedUsd: 0.5,
			hasUnpriced: false,
			onStart: started,
			isRunning: () => true,
		});
		modal.onOpen();

		press(modal, 'Resume');

		expect(queue.isPaused()).toBe(false);
		expect(started).toHaveBeenCalledTimes(1);
	});

	it('closes without stopping the queue it was looking at', () => {
		const { modal, queue } = createSut({ running: true });

		press(modal, 'Close');

		// The work is the point, not the window over it
		expect(queue.hasWork()).toBe(true);
	});
});
