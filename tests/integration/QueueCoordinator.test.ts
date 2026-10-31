/**
 * Tests for the thing the rest of the plugin talks to about the queue: what a
 * folder contributes to it, and how a queue a previous session left is
 * offered back rather than simply started. It calls a paid API, so resuming
 * one because Obsidian was reopened is not a decision to make for the user.
 * @jest-environment jsdom
 */

import { TFile, TFolder } from 'obsidian';
import { QueueCoordinator } from 'src/transcription/QueueCoordinator';
import { QueueRunner } from 'src/transcription/QueueRunner';
import { TranscriptionQueue } from 'src/transcription/TranscriptionQueue';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { createMockApp } from '../helpers/createApp';
import { modalInstances, noticeMessages } from '../mocks/obsidian';
import { ConfirmModal } from 'src/ui/ConfirmModal';
import { TranscriptionQueueModal } from 'src/ui/TranscriptionQueueModal';
import { at } from '../helpers/assertions';
import { FINISHED_RUN } from '../helpers/doubles';

/** A folder tree of the given paths, as the vault reports one. */
function folderOf(name: string, paths: readonly string[]): TFolder {
	const folder = Object.assign(Object.create(TFolder.prototype), {
		name,
		path: name,
		children: paths.map((path) =>
			Object.assign(Object.create(TFile.prototype), {
				path,
				name: path.slice(path.lastIndexOf('/') + 1),
				extension: path.slice(path.lastIndexOf('.') + 1),
			}),
		),
	}) as TFolder;
	return folder;
}

interface Sut {
	coordinator: QueueCoordinator;
	queue: TranscriptionQueue;
	transcribed: string[];
}

/**
 * A coordinator over an empty in-memory queue.
 * @param stored - Entries a previous session left, if any
 * @returns The coordinator, its queue, and what it transcribed
 */
function createSut(stored: { path: string; state: string }[] = []): Sut {
	const transcribed: string[] = [];
	const app = createMockApp({
		vault: {
			getFileByPath: (path: string) =>
				Object.assign(Object.create(TFile.prototype), {
					path,
					name: path,
				}),
		},
	}).app;
	const queue = new TranscriptionQueue(null, app);
	for (const entry of stored) {
		queue.add([entry.path]);
		queue.setState(
			entry.path,
			entry.state as Parameters<TranscriptionQueue['setState']>[1],
		);
	}
	const getSettings = (): ReturnType<typeof mergeSettings> =>
		mergeSettings({ transcriptionEnabled: true });
	return {
		coordinator: new QueueCoordinator({
			app,
			queue,
			runner: new QueueRunner({
				app,
				queue,
				getSettings,
				transcriber: {
					transcribe: ({ file }) => {
						transcribed.push(file.path);
						return Promise.resolve(FINISHED_RUN);
					},
				},
				assumedSecondsPerRecording: 600,
			}),
			getSettings,
			assumedSecondsPerRecording: 600,
		}),
		queue,
		transcribed,
	};
}

describe('queueing a folder', () => {
	it('takes every recording in it and shows what will run', async () => {
		const { coordinator, queue } = createSut();

		await coordinator.queueFolder(
			folderOf('Recordings', ['Recordings/a.webm', 'Recordings/b.webm']),
		);

		expect(queue.entries().map((e) => e.path)).toEqual([
			'Recordings/a.webm',
			'Recordings/b.webm',
		]);
		expect(modalInstances.at(-1)).toBeInstanceOf(TranscriptionQueueModal);
	});

	it('leaves out what is not a recording', async () => {
		const { coordinator, queue } = createSut();

		await coordinator.queueFolder(
			folderOf('Notes', ['Notes/a.webm', 'Notes/plan.md']),
		);

		expect(queue.entries().map((e) => e.path)).toEqual(['Notes/a.webm']);
	});

	it('says so for a folder with no recordings, and opens nothing', async () => {
		const { coordinator } = createSut();
		const before = modalInstances.length;

		await coordinator.queueFolder(folderOf('Notes', ['Notes/plan.md']));

		expect(noticeMessages().join(' ')).toContain('no recordings');
		expect(modalInstances).toHaveLength(before);
	});

	it('says so when the folder is already queued, and adds nothing twice', async () => {
		const { coordinator, queue } = createSut();
		const folder = folderOf('Recordings', ['Recordings/a.webm']);
		await coordinator.queueFolder(folder);

		await coordinator.queueFolder(folder);

		expect(queue.entries()).toHaveLength(1);
		expect(noticeMessages().join(' ')).toContain('already in the queue');
	});
});

describe('a queue a previous session left', () => {
	it('asks before spending money on it', async () => {
		const { coordinator, transcribed } = createSut([
			{ path: 'a.webm', state: 'waiting' },
		]);

		await coordinator.resumeIfPending();

		const modal = modalInstances.at(-1);
		expect(modal).toBeInstanceOf(ConfirmModal);
		// Nothing has run yet: the question is the point
		expect(transcribed).toEqual([]);
	});

	it('carries on once the user says so', async () => {
		const { coordinator, transcribed } = createSut([
			{ path: 'a.webm', state: 'waiting' },
		]);
		await coordinator.resumeIfPending();

		const buttons = Array.from(
			at(
				modalInstances,
				modalInstances.length - 1,
			).modalEl.querySelectorAll('button'),
		);
		buttons.find((b) => b.textContent === 'Continue')?.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(transcribed).toEqual(['a.webm']);
	});

	it('waits again for what was running when the window closed', async () => {
		const { coordinator, queue } = createSut([
			{ path: 'a.webm', state: 'running' },
		]);

		await coordinator.resumeIfPending();

		expect(at(queue.entries(), 0).state).toBe('waiting');
	});

	it('asks nothing when the queue has nothing left to do', async () => {
		const { coordinator } = createSut([{ path: 'a.webm', state: 'done' }]);
		const before = modalInstances.length;

		await coordinator.resumeIfPending();

		expect(modalInstances).toHaveLength(before);
	});

	it('asks nothing when nothing was ever queued', async () => {
		const { coordinator } = createSut();
		const before = modalInstances.length;

		await coordinator.resumeIfPending();

		expect(modalInstances).toHaveLength(before);
	});
});

describe('driving the queue without its dialog', () => {
	it('queues a folder quietly and says what it found and added', async () => {
		const { coordinator, queue } = createSut([
			{ path: 'Recordings/a.webm', state: 'waiting' },
		]);
		const before = modalInstances.length;

		await expect(
			coordinator.enqueueFolder(
				folderOf('Recordings', [
					'Recordings/a.webm',
					'Recordings/b.webm',
				]),
			),
		).resolves.toEqual({ found: 2, added: 1 });
		expect(queue.entries()).toHaveLength(2);
		expect(modalInstances).toHaveLength(before);
		expect(noticeMessages()).toEqual([]);
	});

	it('adds nothing from a folder without recordings', async () => {
		await expect(
			createSut().coordinator.enqueueFolder(
				folderOf('Notes', ['Notes/plan.md']),
			),
		).resolves.toEqual({ found: 0, added: 0 });
	});

	it('reports what the queue holds and whether it runs', async () => {
		const { coordinator, queue } = createSut([
			{ path: 'a.webm', state: 'waiting' },
		]);
		coordinator.pause();

		await expect(coordinator.status()).resolves.toEqual({
			entries: queue.entries(),
			paused: true,
			running: false,
		});
	});

	it('starts transcribing what waits', async () => {
		const { coordinator, transcribed } = createSut([
			{ path: 'a.webm', state: 'waiting' },
		]);

		coordinator.start();
		await Promise.resolve();
		await Promise.resolve();

		expect(transcribed).toEqual(['a.webm']);
	});

	it('removes one entry, and clears the rest', () => {
		const { coordinator, queue } = createSut([
			{ path: 'a.webm', state: 'waiting' },
			{ path: 'b.webm', state: 'waiting' },
			{ path: 'c.webm', state: 'waiting' },
		]);

		expect(coordinator.remove('a.webm')).toBe(true);
		expect(coordinator.remove('gone.webm')).toBe(false);
		expect(queue.entries().map((entry) => entry.path)).toEqual([
			'b.webm',
			'c.webm',
		]);

		coordinator.clear();

		expect(queue.entries()).toEqual([]);
	});
});
