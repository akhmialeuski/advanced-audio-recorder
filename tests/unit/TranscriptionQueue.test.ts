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
	adapter: ReturnType<typeof fakeVaultFiles>['adapter'];
} {
	const { files, adapter } = fakeVaultFiles();
	if (stored !== undefined) {
		files.set(QUEUE_PATH, JSON.stringify(stored));
	}
	const app = createMockApp({ vault: { adapter } }).app;
	return {
		queue: new TranscriptionQueue(QUEUE_PATH, app),
		files,
		app,
		adapter,
	};
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

	it('counts only the recordings a run would still bill for', async () => {
		// What the queue costs is priced from this, so an entry that has
		// already run must not be in it: its money is spent, and counting it
		// quotes the user for work that will not happen again.
		const { queue } = createSut();
		await queue.load();
		queue.add(['a.webm', 'b.webm', 'c.webm']);
		queue.setState('a.webm', 'done');
		queue.setState('b.webm', 'failed');

		expect(queue.pendingCount()).toBe(1);
	});

	it('makes a caller arriving during the first read wait for it', async () => {
		// The plugin loads the queue once the workspace is up while a folder
		// can be queued from the menu at any moment. Marking the queue loaded
		// before the disk had answered let the second caller add to an empty
		// queue, and the file the first caller was still reading then replaced
		// what it added, losing a folder the user had just queued.
		const { files, adapter } = fakeVaultFiles([
			[
				QUEUE_PATH,
				JSON.stringify({
					version: 1,
					paused: false,
					entries: [{ path: 'stored.webm', state: 'waiting' }],
				}),
			],
		]);
		let releaseRead = (): void => {};
		const held = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		adapter.read.mockImplementation(async (path: string) => {
			await held;
			return files.get(path) ?? '';
		});
		const queue = new TranscriptionQueue(
			QUEUE_PATH,
			createMockApp({ vault: { adapter } }).app,
		);

		const first = queue.load();
		const second = (async () => {
			await queue.load();
			queue.add(['added.webm']);
		})();
		releaseRead();
		await Promise.all([first, second]);

		expect(queue.entries().map((entry) => entry.path)).toEqual([
			'stored.webm',
			'added.webm',
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

	it('takes one recording named twice in the same call once', async () => {
		// One path names one entry, and everything below depends on it: the
		// second copy would never leave "waiting", because a state change
		// moves the first entry with that path
		const { queue } = createSut();
		await queue.load();

		expect(queue.add(['a.webm', 'a.webm'])).toBe(1);

		expect(queue.entries().map((e) => e.path)).toEqual(['a.webm']);
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
	/** The one entry a written queue is expected to hold. */
	const ONE_WAITING = [{ path: 'a.webm', state: 'waiting' }];

	/**
	 * A loaded queue with one recording in it, ready to be written.
	 * @returns The queue and the plugin folder it writes into
	 */
	async function queued(): Promise<Awaited<ReturnType<typeof createSut>>> {
		const sut = createSut();
		await sut.queue.load();
		sut.queue.add(['a.webm']);
		return sut;
	}

	it('writes the queue to the plugin folder', async () => {
		const { queue, files } = await queued();

		await queue.flush();

		expect(onDisk(files).entries).toEqual(ONE_WAITING);
	});

	// The debounce used to be a sleep inside the same serialized chain every
	// write goes through, so a flush queued up behind it and ran only once the
	// timer had elapsed. Unload does not get that half second: Obsidian tears
	// the plugin down synchronously, and the last change a user made before
	// quitting came back next session as though it had never happened.
	// The ordinary path, where nobody unloads anything: the queue writes
	// itself a moment after it changed, off a timer of its own.
	it('writes itself once the debounce elapses, with no flush at all', async () => {
		jest.useFakeTimers();
		try {
			const { files } = await queued();

			await jest.runAllTimersAsync();

			expect(onDisk(files).entries).toEqual(ONE_WAITING);
		} finally {
			jest.useRealTimers();
		}
	});

	it('coalesces a burst of changes into one write', async () => {
		jest.useFakeTimers();
		try {
			const { queue, files, adapter } = await queued();
			queue.add(['b.webm']);
			queue.setPaused(true);

			await jest.runAllTimersAsync();

			expect(adapter.write).toHaveBeenCalledTimes(1);
			expect(onDisk(files).entries).toHaveLength(2);
		} finally {
			jest.useRealTimers();
		}
	});

	// A queue is losable by design, so a vault that refuses the write says so
	// in the console and lets the session carry on. Throwing here would take
	// down whatever asked, which at unload is the plugin's own teardown.
	it('reports a write it could not make instead of throwing', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		const { queue, adapter } = await queued();
		adapter.write.mockRejectedValueOnce(new Error('the disk is full'));

		await expect(queue.flush()).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to write the transcription queue'),
			expect.any(Error),
		);
	});

	it('writes on unload without waiting the debounce out', async () => {
		jest.useFakeTimers();
		try {
			const { queue, files } = await queued();

			// No timer is advanced, so anything that reaches disk here got
			// there without the debounce elapsing.
			await queue.flush();

			expect(onDisk(files).entries).toEqual(ONE_WAITING);
		} finally {
			jest.useRealTimers();
		}
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

	it('reads a recording the file names twice as one entry', async () => {
		// A hand-edited or half-written file is the other way a path can
		// arrive twice, and the entry the state changes never reach hands the
		// same recording to a paid API for as long as the drain runs
		const { queue } = createSut({
			version: 1,
			paused: false,
			entries: [
				{ path: 'a.webm', state: 'done' },
				{ path: 'a.webm', state: 'waiting' },
			],
		});

		await queue.load();

		expect(queue.entries()).toEqual([{ path: 'a.webm', state: 'done' }]);
		expect(queue.next()).toBeNull();
	});

	it('starts empty for a queue written by a later version', async () => {
		// Read as this shape it would be written back stamped as this
		// version, losing whatever the newer one added
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The discard is expected; the message is not the assertion
		});
		const { queue } = createSut({
			version: 2,
			paused: false,
			entries: [{ path: 'a.webm', state: 'waiting' }],
		});

		await queue.load();

		expect(queue.entries()).toEqual([]);
		warn.mockRestore();
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
