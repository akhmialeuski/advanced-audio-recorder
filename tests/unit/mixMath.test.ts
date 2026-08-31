/**
 * Tests for the arithmetic of mixing. A mix that clips, pans the wrong way,
 * or drifts off pitch shows up in nothing a file size or a progress bar can
 * report, so the numbers are checked directly.
 */

import {
	gainFactor,
	newResampleState,
	normalizeFactor,
	outputScale,
	panGains,
	resampleWindow,
	sourceFramesNeeded,
	windowRms,
	writeScaled,
} from 'src/recording/mixMath';
import { INT16_MAX } from 'src/audio/pcm';

describe('the multiplier a gain means', () => {
	it('leaves a track alone at zero', () => {
		expect(gainFactor(0)).toBe(1);
	});

	it('halves the amplitude six decibels down', () => {
		expect(gainFactor(-6)).toBeCloseTo(0.501, 3);
	});

	it('doubles it six decibels up', () => {
		expect(gainFactor(6)).toBeCloseTo(1.995, 3);
	});
});

describe('where a pan puts a track', () => {
	it('leaves a centred track at full level on both sides', () => {
		// A track nobody panned has to sound exactly as it did before
		// panning existed
		expect(panGains(0)).toEqual({ left: 1, right: 1 });
	});

	it.each([
		{ pan: -1, expected: { left: 1, right: 0 } },
		{ pan: 1, expected: { left: 0, right: 1 } },
	])('sends a track panned to $pan all one way', ({ pan, expected }) => {
		expect(panGains(pan)).toEqual(expected);
	});

	it('keeps the near side at full level while the far side falls', () => {
		expect(panGains(-0.5)).toEqual({ left: 1, right: 0.5 });
	});

	it('clamps a position outside the field', () => {
		expect(panGains(-9)).toEqual({ left: 1, right: 0 });
		expect(panGains(9)).toEqual({ left: 0, right: 1 });
	});
});

describe('how loud a window is', () => {
	it('measures the root mean square of what it holds', () => {
		expect(windowRms(new Int16Array([3, 4]), 2)).toBeCloseTo(3.536, 3);
	});

	it('reads only the count it was given', () => {
		expect(windowRms(new Int16Array([100, 0, 0, 0]), 1)).toBe(100);
	});

	it('reports silence for an empty window', () => {
		expect(windowRms(new Int16Array(4), 0)).toBe(0);
	});
});

describe('bringing two tracks to one level', () => {
	it('raises a quiet track toward the shared target', () => {
		const factor = normalizeFactor(INT16_MAX * 0.05);

		expect(factor).toBeCloseTo(5, 2);
	});

	it('lowers a track that is louder than the target', () => {
		expect(normalizeFactor(INT16_MAX * 0.5)).toBeCloseTo(0.5, 2);
	});

	it('leaves a track that is only noise alone', () => {
		// Multiplying a muted microphone up makes its hiss the loudest thing
		// in the mix
		expect(normalizeFactor(0)).toBe(1);
		expect(normalizeFactor(0.5)).toBe(1);
	});

	it('never raises a track past the ceiling', () => {
		expect(normalizeFactor(1.5)).toBe(8);
	});
});

describe('bringing a sum onto the output scale', () => {
	it('leaves a sum that already fits', () => {
		expect(outputScale(INT16_MAX)).toBe(1);
		expect(outputScale(1000)).toBe(1);
	});

	it('scales a sum that ran past full scale', () => {
		// Two people talking at once, which clipping would turn into
		// distortion
		expect(outputScale(INT16_MAX * 2)).toBeCloseTo(0.5, 5);
	});
});

describe('writing a window out', () => {
	it('applies the scale to every sample', () => {
		const output = new Int16Array(2);

		writeScaled(new Int32Array([1000, -2000]), output, 0, 2, 0.5);

		expect(Array.from(output)).toEqual([500, -1000]);
	});

	it('writes at the offset it was given', () => {
		const output = new Int16Array(4);

		writeScaled(new Int32Array([100]), output, 2, 1, 1);

		expect(Array.from(output)).toEqual([0, 0, 100, 0]);
	});

	it('clamps what the scale did not catch', () => {
		const output = new Int16Array(2);

		writeScaled(
			new Int32Array([INT16_MAX * 4, -INT16_MAX * 4]),
			output,
			0,
			2,
			1,
		);

		expect(Array.from(output)).toEqual([32767, -32768]);
	});
});

describe('resampling a track to another rate', () => {
	/** Resamples a whole mono signal in one window. */
	function resampleAll(
		source: number[],
		outputFrames: number,
		ratio: number,
	): number[] {
		const target = new Int16Array(outputFrames);
		resampleWindow(
			new Int16Array(source),
			source.length,
			target,
			outputFrames,
			1,
			ratio,
			newResampleState(1),
		);
		return Array.from(target);
	}

	it('copies the signal through at the same rate', () => {
		expect(resampleAll([0, 100, 200, 300], 4, 1)).toEqual([
			0, 100, 200, 300,
		]);
	});

	it('interpolates between frames when slowing down', () => {
		// Half rate: every other output frame sits between two source ones
		expect(resampleAll([0, 100, 200], 5, 0.5)).toEqual([
			0, 50, 100, 150, 200,
		]);
	});

	it('drops frames when speeding up', () => {
		expect(resampleAll([0, 100, 200, 300], 2, 2)).toEqual([0, 200]);
	});

	it('holds the last frame rather than running into silence', () => {
		expect(resampleAll([0, 100], 4, 0.5)).toEqual([0, 50, 100, 100]);
	});

	it('reads the same signal in two windows as it does in one', () => {
		// Every boundary is a click and an accumulating drift if the phase
		// restarts, so two windows have to agree with one
		const whole = resampleAll([0, 100, 200, 300, 400, 500], 4, 1.5);

		const state = newResampleState(1);
		const first = new Int16Array(2);
		resampleWindow(
			new Int16Array([0, 100, 200]),
			3,
			first,
			2,
			1,
			1.5,
			state,
		);
		const second = new Int16Array(2);
		resampleWindow(
			new Int16Array([300, 400, 500]),
			3,
			second,
			2,
			1,
			1.5,
			state,
		);

		expect([...first, ...second]).toEqual(whole);
	});

	it('reaches back into the previous window when the phase lands before it', () => {
		// Reading further than it consumed is the usual case, and the frame
		// the next window interpolates from is then behind its own start
		const state = newResampleState(1);
		resampleWindow(
			new Int16Array([0, 100, 200]),
			3,
			new Int16Array(2),
			2,
			1,
			1,
			state,
		);
		expect(state.position).toBe(-1);

		const second = new Int16Array(2);
		resampleWindow(new Int16Array([300, 400]), 2, second, 2, 1, 1, state);

		// The frame at global index 2 is 200, which only the carry knows
		expect(Array.from(second)).toEqual([200, 300]);
	});

	it('interpolates a stereo frame channel by channel', () => {
		const target = new Int16Array(4);

		resampleWindow(
			new Int16Array([0, 1000, 100, 1100]),
			2,
			target,
			2,
			2,
			0.5,
			newResampleState(2),
		);

		expect(Array.from(target)).toEqual([0, 1000, 50, 1050]);
	});

	describe('how much source one window needs', () => {
		it('asks for one past the last index, for the interpolation', () => {
			expect(sourceFramesNeeded(4, 1, newResampleState(1))).toBe(5);
			expect(sourceFramesNeeded(4, 2, newResampleState(1))).toBe(8);
		});

		it('accounts for where the previous window left off', () => {
			const state = newResampleState(1);
			state.position = -1;

			expect(sourceFramesNeeded(2, 1, state)).toBe(2);
		});

		it('asks for nothing when nothing is wanted', () => {
			expect(sourceFramesNeeded(0, 2, newResampleState(1))).toBe(0);
		});
	});
});
