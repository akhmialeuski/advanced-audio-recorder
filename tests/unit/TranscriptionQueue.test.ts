/**
 * Tests for the queue of recordings to transcribe. What matters is that it
 * survives a restart with its work intact: a month of recordings queued and
 * then lost to a closed window is the thing the queue exists to prevent.
 */

import type { App } from 'obsidian';
import {
	TranscriptionQueue,
	TRANSCRIPTION_QUEUE_FILE,
} from 'src/transcription/TranscriptionQueue';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';
import { at } from '../helpers/assertions';

const QUEUE_PATH = `.obsidian/plugins/aar/${TRANSCRIPTION_QUEUE_FILE}`;

/** A queue over an in-memory plugin folder the test can inspect. */
function createSut(stored?: unknown): {
	queue: TranscriptionQueue;
	files: Map<string, string>;
	app: App;
} {
	const { files, adapter } = fakeVaultFiles();
	if (stored !== undefined) {
		files.set(QUEUE_PATH, JSON.stringify(stored));
	}
	const app = createMockApp({ vault: { adapter } }).app;
	return { queue: new TranscriptionQueue(QUEUE_PATH, app), files, app };
}

/** The state of the queue as written to disk. */
function onDisk(files: Map<string, string>): {
	entries: { path: string; state: string }[];
	paused: boolean;
} {
	return JSON.parse(files.get(QUEUE_PATH) ?? '{}') as {
		entries: { path: string; state: string }[];
		paused: boolean;
	};
}

describe('queueing recordings', () => {
	it('takes the recordings in the order they were given', async () => {
		const { queue } = createSut();
		await queue.load();

		expect(queue.add(['a.webm', 'b.webm'])).toBe(2);

		expect(queue.entries()).toEqual([
			{ path: 'a.webm', state: 'waiting' },
			{ path: 'b.webm', state: 'waiting' },
		]);
	});

	it('skips a recording already queued, which would bill for it twice', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);

		expect(queue.add(['a.webm', 'b.webm'])).toBe(1);

		expect(queue.entries().map((e) => e.path)).toEqual([
			'a.webm',
			'b.webm',
		]);
	});

	it('hands out a copy, so a caller cannot edit the queue by reading it', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);

		at(queue.entries(), 0).state = 'done';

		expect(at(queue.entries(), 0).state).toBe('waiting');
	});

	it('offers the first waiting recording as the next to run', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm', 'b.webm']);
		queue.setState('a.webm', 'done');

		expect(queue.next()?.path).toBe('b.webm');
	});

	it('offers nothing once everything has run', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);
		queue.setState('a.webm', 'done');

		expect(queue.next()).toBeNull();
		expect(queue.hasWork()).toBe(false);
	});

	it('records why an entry failed, and clears it when it runs again', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);

		queue.setState('a.webm', 'failed', 'no API key');
		expect(at(queue.entries(), 0).error).toBe('no API key');

		queue.setState('a.webm', 'waiting');
		expect(at(queue.entries(), 0).error).toBeUndefined();
	});

	it('ignores a state change for a recording it does not hold', async () => {
		const { queue } = createSut();
		await queue.load();

		expect(() => {
			queue.setState('gone.webm', 'done');
		}).not.toThrow();
		expect(queue.entries()).toEqual([]);
	});
});

describe('pausing, resuming, and dropping an entry', () => {
	it('starts nothing new while paused', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);

		queue.setPaused(true);

		expect(queue.next()).toBeNull();
		// Still work to do: paused is not finished
		expect(queue.hasWork()).toBe(true);
		queue.setPaused(false);
		expect(queue.next()?.path).toBe('a.webm');
	});

	it('drops one waiting entry', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm', 'b.webm']);

		expect(queue.remove('a.webm')).toBe(true);

		expect(queue.entries().map((e) => e.path)).toEqual(['b.webm']);
	});

	it('leaves the recording that is running where it is', async () => {
		// Stopping it is the run's own business, and dropping the entry would
		// lose the record of what it is doing
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm']);
		queue.setState('a.webm', 'running');

		expect(queue.remove('a.webm')).toBe(false);
		expect(queue.entries()).toHaveLength(1);
	});

	it('reports nothing removed for a recording it does not hold', async () => {
		const { queue } = createSut();
		await queue.load();

		expect(queue.remove('gone.webm')).toBe(false);
	});

	it('empties the queue but keeps what is running', async () => {
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm', 'b.webm']);
		queue.setState('a.webm', 'running');

		queue.clear();

		expect(queue.entries().map((e) => e.path)).toEqual(['a.webm']);
	});
});

describe('surviving a restart', () => {
	it('writes the queue to the plugin folder', async () => {
		const { queue, files } = createSut();
		await queue.load();
		queue.add(['a.webm']);

		await queue.flush();

		expect(onDisk(files).entries).toEqual([
			{ path: 'a.webm', state: 'waiting' },
		]);
	});

	it('reads back the queue a previous session left', async () => {
		const { queue } = createSut({
			version: 1,
			paused: true,
			entries: [
				{ path: 'a.webm', state: 'done' },
				{ path: 'b.webm', state: 'waiting' },
			],
		});

		await queue.load();

		expect(queue.entries().map((e) => e.path)).toEqual([
			'a.webm',
			'b.webm',
		]);
		expect(queue.isPaused()).toBe(true);
		expect(queue.hasWork()).toBe(true);
	});

	it('waits again for a recording that was running when the window closed', async () => {
		// Nothing will finish it, and leaving it running strands the queue
		const { queue } = createSut({
			version: 1,
			paused: false,
			entries: [{ path: 'a.webm', state: 'running' }],
		});
		await queue.load();

		queue.requeueInterrupted();

		expect(at(queue.entries(), 0).state).toBe('waiting');
		expect(queue.next()?.path).toBe('a.webm');
	});

	it('leaves a queue with nothing interrupted alone', async () => {
		const { queue } = createSut({
			version: 1,
			paused: false,
			entries: [{ path: 'a.webm', state: 'done' }],
		});
		await queue.load();

		queue.requeueInterrupted();

		expect(at(queue.entries(), 0).state).toBe('done');
	});

	it.each([
		{
			case: 'a file that is not JSON',
			stored: undefined,
			raw: '{ not json',
		},
		{ case: 'a file that is not a queue', stored: { hello: true } },
		{
			case: 'entries that are not a list',
			stored: { version: 1, paused: false, entries: 7 },
		},
		{
			case: 'an entry with no path',
			stored: {
				version: 1,
				paused: false,
				entries: [{ state: 'waiting' }],
			},
		},
		{
			case: 'an entry in a state it does not know',
			stored: {
				version: 1,
				paused: false,
				entries: [{ path: 'a.webm', state: 'sideways' }],
			},
		},
		{
			case: 'an entry that is not an object',
			stored: { version: 1, paused: false, entries: ['a.webm'] },
		},
	])('starts empty for $case', async ({ stored, raw }) => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The empty queue is the assertion.
		});
		const { files, app } = createSut(stored);
		if (raw !== undefined) {
			files.set(QUEUE_PATH, raw);
		}
		const queue = new TranscriptionQueue(QUEUE_PATH, app);

		await queue.load();

		expect(queue.entries()).toEqual([]);
		warn.mockRestore();
	});

	it('starts empty when no queue was ever written', async () => {
		const { queue } = createSut();

		await queue.load();

		expect(queue.entries()).toEqual([]);
	});

	it('reads the file once, however often load is called', async () => {
		const { queue, app } = createSut({
			version: 1,
			paused: false,
			entries: [],
		});
		const read = jest.spyOn(app.vault.adapter, 'read');

		await queue.load();
		await queue.load();

		expect(read).toHaveBeenCalledTimes(1);
		read.mockRestore();
	});

	it('keeps working when the plugin folder is unknown', async () => {
		const { app } = createSut();
		const queue = new TranscriptionQueue(null, app);

		await queue.load();
		queue.add(['a.webm']);
		await queue.flush();

		// Memory-only: the queue still runs, it just does not outlive the session
		expect(queue.entries()).toHaveLength(1);
	});
});

describe('telling a view the queue moved', () => {
	it('tells a listener after every change', async () => {
		const { queue } = createSut();
		await queue.load();
		const listener = jest.fn();
		queue.subscribe(listener);

		queue.add(['a.webm']);
		queue.setState('a.webm', 'running');
		queue.setPaused(true);

		expect(listener).toHaveBeenCalledTimes(3);
	});

	it('stops telling a listener that unsubscribed', async () => {
		const { queue } = createSut();
		await queue.load();
		const listener = jest.fn();
		queue.subscribe(listener)();

		queue.add(['a.webm']);

		expect(listener).not.toHaveBeenCalled();
	});
});
