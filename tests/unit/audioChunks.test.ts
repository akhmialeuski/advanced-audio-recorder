/**
 * Tests for splitChunkPlan: halving a chunk plan so a part that overran a
 * provider's output token limit can be retried as smaller pieces. The split
 * must tile the original span exactly (no gap or overlap at the midpoint) and
 * must stop once the halves would fall below the minimum length.
 * @module tests/unit/audioChunks.test
 */

import { splitChunkPlan, type ChunkPlan } from 'src/transcription/audioChunks';
import { at } from '../helpers/assertions';

const MIN_SECONDS = 60;

describe('splitChunkPlan', () => {
	it('halves a chunk at its midpoint, tiling the span exactly', () => {
		const chunk: ChunkPlan = { index: 1, startSeconds: 0, endSeconds: 900 };
		const halves = splitChunkPlan(chunk, MIN_SECONDS);
		expect(halves).toHaveLength(2);
		expect(at(halves, 0).startSeconds).toBe(0);
		expect(at(halves, 0).endSeconds).toBe(450);
		// The second half starts exactly where the first ends: no gap, no overlap.
		expect(at(halves, 1).startSeconds).toBe(450);
		expect(at(halves, 1).endSeconds).toBe(900);
	});

	it('carries the offset so an inner part keeps its place on the timeline', () => {
		const chunk: ChunkPlan = {
			index: 0,
			startSeconds: 600,
			endSeconds: 1200,
		};
		const halves = splitChunkPlan(chunk, MIN_SECONDS);
		expect(halves[0]).toMatchObject({ startSeconds: 600, endSeconds: 900 });
		expect(halves[1]).toMatchObject({
			startSeconds: 900,
			endSeconds: 1200,
		});
	});

	it('still splits a chunk exactly twice the minimum', () => {
		const chunk: ChunkPlan = {
			index: 0,
			startSeconds: 0,
			endSeconds: 2 * MIN_SECONDS,
		};
		expect(splitChunkPlan(chunk, MIN_SECONDS)).toHaveLength(2);
	});

	it('returns no halves once a chunk is below twice the minimum (the floor)', () => {
		const chunk: ChunkPlan = {
			index: 0,
			startSeconds: 0,
			endSeconds: 2 * MIN_SECONDS - 1,
		};
		expect(splitChunkPlan(chunk, MIN_SECONDS)).toEqual([]);
	});
});
