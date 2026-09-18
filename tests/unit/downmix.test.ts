/**
 * Unit tests for the channel-mode and downmix helpers.
 * @module tests/unit/downmix.test
 */

import {
	isChannelMode,
	normalizeChannelMode,
	isMonoChannelMode,
	monoPickIndex,
	downmixChannelData,
	downmixAudioBuffer,
} from 'src/audio/downmix';
import { partial } from '../helpers/doubles';

/** Minimal AudioBuffer double backed by per-channel Float32Arrays. */
class FakeAudioBuffer {
	readonly numberOfChannels: number;
	readonly length: number;
	readonly sampleRate: number;
	private readonly channels: Float32Array[];

	constructor(options: {
		length: number;
		numberOfChannels: number;
		sampleRate: number;
	}) {
		this.length = options.length;
		this.numberOfChannels = options.numberOfChannels;
		this.sampleRate = options.sampleRate;
		this.channels = Array.from(
			{ length: options.numberOfChannels },
			() => new Float32Array(options.length),
		);
	}

	getChannelData(index: number): Float32Array {
		const channel = this.channels[index];
		if (!channel) {
			throw new Error(`No channel ${String(index)}`);
		}
		return channel;
	}
}

beforeAll(() => {
	(global as Record<string, unknown>).AudioBuffer = FakeAudioBuffer;
});

afterAll(() => {
	delete (global as Record<string, unknown>).AudioBuffer;
});

function stereoBuffer(
	left: number[],
	right: number[],
	sampleRate = 44100,
): AudioBuffer {
	const buffer = new FakeAudioBuffer({
		length: left.length,
		numberOfChannels: 2,
		sampleRate,
	});
	buffer.getChannelData(0).set(left);
	buffer.getChannelData(1).set(right);
	return partial<AudioBuffer>(buffer);
}

/**
 * The channel-mode strings as they are written to data.json, spelled out here
 * rather than read from the ChannelMode object: a rename of a member has to
 * fail this test rather than quietly change what a saved setting holds.
 */
const STORED_CHANNEL_MODES = [
	'source',
	'mono-mix',
	'mono-left',
	'mono-right',
] as const;

describe('channel mode guards', () => {
	it('accepts every declared mode', () => {
		for (const mode of STORED_CHANNEL_MODES) {
			expect(isChannelMode(mode)).toBe(true);
		}
	});

	it.each([undefined, null, 42, 'stereo', 'MONO-MIX', {}])(
		'rejects %p',
		(value) => {
			expect(isChannelMode(value)).toBe(false);
		},
	);

	it('normalizes invalid values to the source mode', () => {
		expect(normalizeChannelMode('bogus')).toBe('source');
		expect(normalizeChannelMode(undefined)).toBe('source');
		expect(normalizeChannelMode('mono-left')).toBe('mono-left');
	});

	it('classifies mono modes', () => {
		expect(isMonoChannelMode('source')).toBe(false);
		expect(isMonoChannelMode('mono-mix')).toBe(true);
		expect(isMonoChannelMode('mono-left')).toBe(true);
		expect(isMonoChannelMode('mono-right')).toBe(true);
	});
});

describe.each([
	{ name: 'stereo', channels: 2, left: 0, right: 1 },
	{ name: 'mono', channels: 1, left: 0, right: 0 },
	{ name: 'no channels at all', channels: 0, left: 0, right: 0 },
])('monoPickIndex on $name input', ({ channels, left, right }) => {
	// The index goes straight into a channel array; a negative or
	// out-of-range one would read past the end of a capture.
	it('picks the left channel', () => {
		expect(monoPickIndex('mono-left', channels)).toBe(left);
	});

	it('picks the right channel, clamped to what exists', () => {
		expect(monoPickIndex('mono-right', channels)).toBe(right);
	});

	it.each(['source', 'mono-mix'] as const)(
		'picks nothing for the %s mode, which mixes rather than picks',
		(mode) => {
			expect(monoPickIndex(mode, channels)).toBeNull();
		},
	);
});

describe('downmixChannelData', () => {
	const left = Float32Array.from([0.5, -0.5, 1]);
	const right = Float32Array.from([-0.5, -0.5, 0]);

	it('averages all channels in the mix mode', () => {
		const mixed = downmixChannelData([left, right], 'mono-mix');

		expect(Array.from(mixed)).toEqual([0, -0.5, 0.5]);
	});

	it('averages more than two channels', () => {
		const third = Float32Array.from([0.5, 0.5, 0.5]);
		const mixed = downmixChannelData([left, right, third], 'mono-mix');

		expect(mixed[0]).toBeCloseTo(1 / 6);
		expect(mixed[1]).toBeCloseTo(-1 / 6);
		expect(mixed[2]).toBeCloseTo(0.5);
	});

	it('returns a copy of the picked channel', () => {
		const picked = downmixChannelData([left, right], 'mono-right');

		expect(Array.from(picked)).toEqual(Array.from(right));
		expect(picked).not.toBe(right);
	});

	it('falls back to the first channel for a right pick on mono data', () => {
		const picked = downmixChannelData([left], 'mono-right');

		expect(Array.from(picked)).toEqual(Array.from(left));
	});

	it('throws for the source mode and for empty data', () => {
		expect(() => downmixChannelData([left], 'source')).toThrow();
		expect(() => downmixChannelData([], 'mono-mix')).toThrow();
	});

	// Both production callers fill the array densely, so the two `??` guards
	// in downmixChannelData answer the compiler rather than a caller:
	// noUncheckedIndexedAccess types an indexed read as possibly undefined.
	// A list whose length counts a channel it does not hold is the synthetic
	// input that reaches them, and these two cases pin what each one yields.
	it('falls back to the first channel when the picked one is absent', () => {
		const sparse: Float32Array[] = [left];
		sparse.length = 2;

		expect(Array.from(downmixChannelData(sparse, 'mono-right'))).toEqual(
			Array.from(left),
		);
	});

	it('mixes an absent channel as silence', () => {
		const sparse: Float32Array[] = [left];
		sparse.length = 2;

		expect(Array.from(downmixChannelData(sparse, 'mono-mix'))).toEqual([
			0.25, -0.25, 0.5,
		]);
	});
});

describe('downmixAudioBuffer', () => {
	it('returns the buffer unchanged for the source mode', () => {
		const buffer = stereoBuffer([0.5], [-0.5]);

		expect(downmixAudioBuffer(buffer, 'source')).toBe(buffer);
	});

	it('returns an already-mono buffer unchanged', () => {
		const mono = partial<AudioBuffer>(
			new FakeAudioBuffer({
				length: 2,
				numberOfChannels: 1,
				sampleRate: 48000,
			}),
		);

		expect(downmixAudioBuffer(mono, 'mono-mix')).toBe(mono);
	});

	it('mixes a stereo buffer down to mono', () => {
		const buffer = stereoBuffer([0.5, 1], [-0.5, 0], 48000);

		const mono = downmixAudioBuffer(buffer, 'mono-mix');

		expect(mono.numberOfChannels).toBe(1);
		expect(mono.sampleRate).toBe(48000);
		expect(mono).toHaveLength(2);
		expect(Array.from(mono.getChannelData(0))).toEqual([0, 0.5]);
	});

	it('keeps only the picked channel', () => {
		const buffer = stereoBuffer([0.5, 1], [-0.5, 0]);

		const mono = downmixAudioBuffer(buffer, 'mono-left');

		expect(Array.from(mono.getChannelData(0))).toEqual([0.5, 1]);
	});
});
