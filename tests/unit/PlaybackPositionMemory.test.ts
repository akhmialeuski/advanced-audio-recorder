/**
 * Tests for the remembered playback position: which offsets are worth
 * keeping, when a recording counts as heard, and that a sidecar that cannot
 * be written never surfaces as anything but a warning.
 */

import { PlaybackPositionMemory } from 'src/player/PlaybackPositionMemory';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlaybackState } from 'src/sidecar/recordingSidecarModel';
import { partial } from '../helpers/doubles';
import { tick } from '../helpers/async';

const PATH = 'Recordings/lecture.webm';

/** An in-memory store double recording what the memory wrote. */
function createSut(initial: number | null = null): {
	memory: PlaybackPositionMemory;
	read: () => number | null;
	writes: jest.Mock;
} {
	let position = initial;
	const writes = jest.fn((_path: string, state: PlaybackState | null) => {
		position = state?.position ?? null;
		return Promise.resolve();
	});
	const store = partial<RecordingSidecarStore>({
		getPlayback: jest.fn(() =>
			Promise.resolve(
				position === null
					? null
					: { position, updatedAt: '2026-08-28T10:00:00.000Z' },
			),
		),
		setPlayback: writes,
	});
	return {
		memory: new PlaybackPositionMemory(store, PATH),
		read: () => position,
		writes,
	};
}

describe('reading the remembered position', () => {
	it('returns the stored offset', async () => {
		const { memory } = createSut(600);

		await expect(memory.stored()).resolves.toBe(600);
	});

	it('returns null when the recording was never left part-heard', async () => {
		const { memory } = createSut();

		await expect(memory.stored()).resolves.toBeNull();
	});

	it('reports no position when the sidecar cannot be read', async () => {
		const store = partial<RecordingSidecarStore>({
			getPlayback: jest.fn(() => Promise.reject(new Error('unreadable'))),
		});
		const memory = new PlaybackPositionMemory(store, PATH);

		await expect(memory.stored()).resolves.toBeNull();
	});
});

describe('recording where playback stands', () => {
	it('stores a position well inside the recording', async () => {
		const { memory, read } = createSut();

		memory.remember(842.7, 3600);
		await tick();

		expect(read()).toBe(842);
	});

	it.each([
		{ case: 'the opening seconds', position: 4, duration: 3600 },
		{ case: 'the closing seconds', position: 3595, duration: 3600 },
	])('forgets a position in $case', async ({ position, duration }) => {
		const { memory, read } = createSut(600);
		await memory.stored();

		memory.remember(position, duration);
		await tick();

		expect(read()).toBeNull();
	});

	it('stores a late position while the duration is still unknown', async () => {
		const { memory, read } = createSut();

		memory.remember(3595, null);
		await tick();

		expect(read()).toBe(3595);
	});

	it('writes once for a position it has already stored', async () => {
		const { memory, writes } = createSut();

		memory.remember(842.1, 3600);
		memory.remember(842.9, 3600);
		await tick();

		expect(writes).toHaveBeenCalledTimes(1);
	});

	it('forgets a position that was stored in an earlier session', async () => {
		const { memory, read } = createSut(600);
		await memory.stored();

		memory.forget();
		await tick();

		expect(read()).toBeNull();
	});

	it('writes nothing when there was no position to forget', async () => {
		const { memory, writes } = createSut();
		await memory.stored();

		memory.forget();
		await tick();

		expect(writes).not.toHaveBeenCalled();
	});

	it('warns instead of throwing when the sidecar refuses the write', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The message is the assertion; keep the test output readable.
		});
		const store = partial<RecordingSidecarStore>({
			setPlayback: jest.fn(() => Promise.reject(new Error('refused'))),
		});

		new PlaybackPositionMemory(store, PATH).remember(842, 3600);
		await tick();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(PATH),
			expect.any(Error),
		);
		warn.mockRestore();
	});
});
