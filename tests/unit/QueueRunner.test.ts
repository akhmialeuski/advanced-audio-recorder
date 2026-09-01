/**
 * Tests for draining the transcription queue. One recording at a time, one
 * failure never stranding the rest, and every run counted into the session
 * total by the same rule a single run follows.
 */

import { TFile } from 'obsidian';
import {
	QueueRunner,
	type QueueTranscriber,
} from 'src/transcription/QueueRunner';
import {
	TranscriptionQueue,
	TRANSCRIPTION_QUEUE_FILE,
} from 'src/transcription/TranscriptionQueue';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';
import { noticeMessages } from '../mocks/obsidian';
import { at } from '../helpers/assertions';

/**
 * How long the queue assumes one recording to be. The queue never measures a
 * file before sending it, so this is what a fallback estimate is sized by.
 */
const ASSUMED_SECONDS = 600;

/** Where a queue read back from disk lives in these cases. */
const QUEUE_PATH = `.obsidian/plugins/aar/${TRANSCRIPTION_QUEUE_FILE}`;

/**
 * Calls after which a drain that will not end is stopped, so the case that
 * guards against one fails on its assertion instead of never returning.
 */
const RUNAWAY_CALL_CAP = 5;

/**
 * The cancellation a run is handed, taken from the runner's own contract so
 * the test records exactly the type it passes on.
 */
type RunToken = Parameters<QueueTranscriber>[1]['token'];

/** A priced run, as the service reports one. */
function cost(usd: number | null = 0.05): TranscribeRunCost {
	return { engineId: 'deepgram', usd, usage: {} };
}

/**
 * A run that stops the drain and then rejects the way an aborted request
 * does, which is what unloading the plugin looks like from inside one.
 * @param runner - The runner whose drain is stopped
 * @returns The rejection the stopped run answers with
 */
function stoppedRun(runner: QueueRunner): Promise<{ cost: TranscribeRunCost }> {
	runner.stop();
	return Promise.reject(new Error('signal is aborted'));
}

/** One finished run as the session counter was handed it. */
interface RecordedRun {
	engineId: string;
	usd: number | null;
	seconds: number | null;
}

interface Sut {
	runner: QueueRunner;
	queue: TranscriptionQueue;
	transcribed: string[];
	recorded: RecordedRun[];
	/** The cancellation each run was handed, in the order they ran. */
	tokens: RunToken[];
}

/**
 * A runner over a queue of the given recordings.
 * @param options - What this case varies
 * @returns The runner, its queue, and what it did
 */
function createSut(
	options: {
		paths?: string[];
		missing?: string[];
		answer?: (path: string) => Promise<{ cost: TranscribeRunCost }>;
		/** A queue built by the case, for one read back from disk. */
		queue?: TranscriptionQueue;
	} = {},
): Sut {
	const paths = options.paths ?? ['a.webm', 'b.webm'];
	const missing = new Set(options.missing ?? []);
	const transcribed: string[] = [];
	const recorded: RecordedRun[] = [];
	const tokens: RunToken[] = [];
	const app = createMockApp({
		vault: {
			getAbstractFileByPath: (path: string) =>
				missing.has(path)
					? null
					: Object.assign(Object.create(TFile.prototype), {
							path,
							name: path,
						}),
		},
	}).app;
	const queue = options.queue ?? new TranscriptionQueue(null, app);
	if (!options.queue) {
		queue.add(paths);
	}
	const runner = new QueueRunner({
		app,
		queue,
		getSettings: () => mergeSettings({}),
		transcribe: (file, runOptions) => {
			transcribed.push(file.path);
			tokens.push(runOptions.token);
			return (
				options.answer?.(file.path) ?? Promise.resolve({ cost: cost() })
			);
		},
		costSink: {
			recordRun: (cost, _settings, durationSeconds) => {
				recorded.push({
					engineId: cost.engineId,
					usd: cost.usd,
					seconds: durationSeconds,
				});
				return cost.usd;
			},
		},
		assumedSecondsPerRecording: ASSUMED_SECONDS,
	});
	return { runner, queue, transcribed, recorded, tokens };
}

describe('draining the queue', () => {
	it('transcribes every queued recording, in order', async () => {
		const { runner, transcribed, queue } = createSut();

		await runner.drain();

		expect(transcribed).toEqual(['a.webm', 'b.webm']);
		expect(queue.entries().map((e) => e.state)).toEqual(['done', 'done']);
		expect(queue.hasWork()).toBe(false);
	});

	it('marks each recording running while it runs', async () => {
		const states: string[] = [];
		const { runner, queue } = createSut({
			paths: ['a.webm'],
			answer: () => {
				states.push(at(queue.entries(), 0).state);
				return Promise.resolve({ cost: cost() });
			},
		});

		await runner.drain();

		expect(states).toEqual(['running']);
	});

	it('carries on past a recording the engine refused', async () => {
		const { runner, queue, transcribed } = createSut({
			answer: (path) =>
				path === 'a.webm'
					? Promise.reject(new Error('rate limited'))
					: Promise.resolve({ cost: cost() }),
		});

		await runner.drain();

		expect(transcribed).toEqual(['a.webm', 'b.webm']);
		expect(queue.entries()).toEqual([
			{ path: 'a.webm', state: 'failed', error: 'rate limited' },
			{ path: 'b.webm', state: 'done' },
		]);
		expect(noticeMessages().join(' ')).toContain('rate limited');
	});

	it('reports a rejection that is not an error at all', async () => {
		const { runner, queue } = createSut({
			paths: ['a.webm'],
			answer: () => Promise.reject('the disk went away'),
		});

		await runner.drain();

		expect(at(queue.entries(), 0).error).toBe('the disk went away');
	});

	it('marks a recording that has left the vault, without calling the engine', async () => {
		const { runner, queue, transcribed } = createSut({
			paths: ['gone.webm'],
			missing: ['gone.webm'],
		});

		await runner.drain();

		expect(transcribed).toEqual([]);
		expect(at(queue.entries(), 0).state).toBe('failed');
		expect(at(queue.entries(), 0).error).toContain(
			'no longer in the vault',
		);
	});

	it('starts a queue that was left paused', async () => {
		// A pause outlived the drain that honoured it. Once the recording in
		// flight had finished the loop exited, the dialog stopped offering
		// Resume, and the flag was left on disk with nothing able to clear
		// it: Start called drain, drain read the flag and returned, and the
		// queue could not be run again in this session or any later one.
		const { runner, queue, transcribed } = createSut();
		queue.setPaused(true);

		await runner.drain();

		expect(transcribed).toEqual(['a.webm', 'b.webm']);
		expect(queue.isPaused()).toBe(false);
	});

	it('stops after the recording in flight when the queue is paused', async () => {
		const { runner, queue, transcribed } = createSut({
			answer: (path) => {
				if (path === 'a.webm') {
					queue.setPaused(true);
				}
				return Promise.resolve({ cost: cost() });
			},
		});

		await runner.drain();

		expect(transcribed).toEqual(['a.webm']);
		expect(queue.hasWork()).toBe(true);
	});

	it('hands each run a cancellation that the stop aborts', async () => {
		// The request the drain has in flight belongs to the plugin that
		// started it, so unloading has to be able to end it rather than let
		// it finish against a vault the plugin has left.
		const { runner, tokens } = createSut({
			paths: ['a.webm'],
			answer: () => {
				runner.stop();
				return Promise.resolve({ cost: cost() });
			},
		});

		await runner.drain();

		expect(at(tokens, 0)?.isCancelled()).toBe(true);
	});

	it('starts nothing after the drain is stopped', async () => {
		const { runner, transcribed } = createSut({
			answer: (path) => {
				if (path === 'a.webm') {
					runner.stop();
				}
				return Promise.resolve({ cost: cost() });
			},
		});

		await runner.drain();

		expect(transcribed).toEqual(['a.webm']);
	});

	it('leaves a stopped recording queued rather than failed', async () => {
		// The abort reaches the run as a rejection, and recording that as a
		// failure would leave the user clearing by hand something the engine
		// never refused; it waits instead, so the next session picks it up.
		const { runner, queue } = createSut({
			answer: (path) =>
				path === 'a.webm'
					? stoppedRun(runner)
					: Promise.resolve({ cost: cost() }),
		});

		await runner.drain();

		expect(queue.entries().map((entry) => entry.state)).toEqual([
			'waiting',
			'waiting',
		]);
		expect(noticeMessages()).toEqual([]);
	});

	it('runs again after a stop, on a fresh cancellation', async () => {
		// The source is rebuilt at the start of each drain, so a stop cannot
		// leave the runner permanently unable to start.
		let stopThisRun = true;
		const { runner, queue, transcribed } = createSut({
			paths: ['a.webm'],
			answer: () => {
				if (!stopThisRun) {
					return Promise.resolve({ cost: cost() });
				}
				stopThisRun = false;
				return stoppedRun(runner);
			},
		});
		await runner.drain();

		await runner.drain();

		expect(transcribed).toEqual(['a.webm', 'a.webm']);
		expect(at(queue.entries(), 0).state).toBe('done');
	});

	it('does nothing while a drain is already running', async () => {
		const { runner, transcribed } = createSut({
			answer: async (path) => {
				if (path === 'a.webm') {
					// A second caller arriving mid-run must not double the work
					await runner.drain();
				}
				return { cost: cost() };
			},
		});

		await runner.drain();

		expect(transcribed).toEqual(['a.webm', 'b.webm']);
		expect(runner.isRunning()).toBe(false);
	});

	it('does nothing for an empty queue', async () => {
		const { runner, transcribed } = createSut({ paths: [] });

		await runner.drain();

		expect(transcribed).toEqual([]);
	});

	it('ends on a stored queue naming one recording twice', async () => {
		// The drain runs until nothing is waiting, and a state change moves
		// the first entry with that path, so a second copy is one nothing can
		// ever move and the same recording goes to a paid API for as long as
		// the drain lives. The cap keeps a regression here a failed
		// assertion rather than a test that never returns.
		const { files, adapter } = fakeVaultFiles();
		files.set(
			QUEUE_PATH,
			JSON.stringify({
				version: 1,
				paused: false,
				entries: [
					{ path: 'a.webm', state: 'waiting' },
					{ path: 'a.webm', state: 'waiting' },
				],
			}),
		);
		const queue = new TranscriptionQueue(
			QUEUE_PATH,
			createMockApp({ vault: { adapter } }).app,
		);
		await queue.load();
		const sut = createSut({
			queue,
			answer: () => {
				if (sut.transcribed.length >= RUNAWAY_CALL_CAP) {
					queue.setPaused(true);
				}
				return Promise.resolve({ cost: cost() });
			},
		});

		await sut.runner.drain();

		expect(sut.transcribed).toEqual(['a.webm']);
		await queue.flush();
	});
});

describe('what a queued run costs the session', () => {
	// What the runner owes is handing a finished run to the session counter
	// with the length the queue was priced at; how that becomes a figure is
	// the shared rule's, pinned where the rule lives.
	it('hands a finished run over at the length the queue was quoted', async () => {
		const { runner, recorded } = createSut({ paths: ['a.webm'] });

		await runner.drain();

		expect(recorded).toEqual([
			{ engineId: 'deepgram', usd: 0.05, seconds: ASSUMED_SECONDS },
		]);
	});

	// The queue used to record such a run as unpriced where the dialog fell
	// back to the duration estimate, so the same recording reached the
	// session total differently depending on which surface had started it.
	it('hands over a run the provider priced nothing for', async () => {
		const { runner, recorded } = createSut({
			paths: ['a.webm'],
			answer: () => Promise.resolve({ cost: cost(null) }),
		});

		await runner.drain();

		expect(recorded).toEqual([
			{ engineId: 'deepgram', usd: null, seconds: ASSUMED_SECONDS },
		]);
	});

	it('hands over nothing for a run that failed', async () => {
		const { runner, recorded } = createSut({
			paths: ['a.webm'],
			answer: () => Promise.reject(new Error('refused')),
		});

		await runner.drain();

		expect(recorded).toEqual([]);
	});
});
