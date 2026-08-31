/**
 * Tests for draining the transcription queue. One recording at a time, one
 * failure never stranding the rest, and every run counted into the session
 * total by the same rule a single run follows.
 */

import { TFile } from 'obsidian';
import { QueueRunner } from 'src/transcription/QueueRunner';
import { TranscriptionQueue } from 'src/transcription/TranscriptionQueue';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { createMockApp } from '../helpers/createApp';
import { noticeMessages } from '../mocks/obsidian';
import { at } from '../helpers/assertions';

/**
 * How long the queue assumes one recording to be. The queue never measures a
 * file before sending it, so this is what a fallback estimate is sized by.
 */
const ASSUMED_SECONDS = 600;

/** A priced run, as the service reports one. */
function cost(usd: number | null = 0.05): TranscribeRunCost {
	return { engineId: 'deepgram', usd, usage: {} };
}

interface Sut {
	runner: QueueRunner;
	queue: TranscriptionQueue;
	transcribed: string[];
	added: [string, number | null, boolean | undefined][];
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
		estimates?: boolean;
	} = {},
): Sut {
	const paths = options.paths ?? ['a.webm', 'b.webm'];
	const missing = new Set(options.missing ?? []);
	const transcribed: string[] = [];
	const added: [string, number | null, boolean | undefined][] = [];
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
	const queue = new TranscriptionQueue(null, app);
	queue.add(paths);
	const runner = new QueueRunner({
		app,
		queue,
		getSettings: () =>
			mergeSettings({
				transcriptionShowCostEstimates: options.estimates ?? true,
			}),
		transcribe: (file) => {
			transcribed.push(file.path);
			return (
				options.answer?.(file.path) ?? Promise.resolve({ cost: cost() })
			);
		},
		costSink: {
			add: (engineId, usd, estimated) => {
				added.push([engineId, usd, estimated]);
			},
		},
		assumedSecondsPerRecording: ASSUMED_SECONDS,
	});
	return { runner, queue, transcribed, added };
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
});

describe('what a queued run costs the session', () => {
	it('counts what the provider reported', async () => {
		const { runner, added } = createSut({ paths: ['a.webm'] });

		await runner.drain();

		expect(added).toEqual([['deepgram', 0.05, false]]);
	});

	// A run the provider reported no usage for falls back to the duration
	// estimate and is marked as one, which is what the dialog has always done.
	// Recording it as unpriced instead, as the queue used to, left the same
	// recording reaching the session total differently depending on which
	// surface had started it.
	it('falls back to the estimate when the provider priced nothing', async () => {
		const { runner, added } = createSut({
			paths: ['a.webm'],
			answer: () => Promise.resolve({ cost: cost(null) }),
		});

		await runner.drain();

		// The figure itself is the shared rule's, pinned where that rule lives;
		// what matters here is that the runner asked it rather than recording
		// the unpriced null it used to.
		expect(added).toEqual([['deepgram', expect.any(Number), true]]);
	});

	it('counts nothing while cost estimates are off', async () => {
		const { runner, added } = createSut({
			paths: ['a.webm'],
			estimates: false,
		});

		await runner.drain();

		expect(added).toEqual([]);
	});

	it('counts nothing for a run that failed', async () => {
		const { runner, added } = createSut({
			paths: ['a.webm'],
			answer: () => Promise.reject(new Error('refused')),
		});

		await runner.drain();

		expect(added).toEqual([]);
	});
});
