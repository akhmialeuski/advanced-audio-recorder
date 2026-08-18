/**
 * Unit tests for the channel-mode and downmix helpers.
 * @module tests/unit/downmix.test
 */

import {
	CHANNEL_MODES,
	CHANNEL_MODE_SOURCE,
	CHANNEL_MODE_MONO_MIX,
	CHANNEL_MODE_MONO_LEFT,
	CHANNEL_MODE_MONO_RIGHT,
	isChannelMode,
	normalizeChannelMode,
	isMonoChannelMode,
	monoPickIndex,
	downmixChannelData,
	downmixAudioBuffer,
} from 'src/audio/downmix';

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
	return buffer as unknown as AudioBuffer;
}

describe('channel mode guards', () => {
	it('accepts every declared mode', () => {
		for (const mode of CHANNEL_MODES) {
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
		expect(normalizeChannelMode('bogus')).toBe(CHANNEL_MODE_SOURCE);
		expect(normalizeChannelMode(undefined)).toBe(CHANNEL_MODE_SOURCE);
		expect(normalizeChannelMode(CHANNEL_MODE_MONO_LEFT)).toBe(
			CHANNEL_MODE_MONO_LEFT,
		);
	});

	it('classifies mono modes', () => {
		expect(isMonoChannelMode(CHANNEL_MODE_SOURCE)).toBe(false);
		expect(isMonoChannelMode(CHANNEL_MODE_MONO_MIX)).toBe(true);
		expect(isMonoChannelMode(CHANNEL_MODE_MONO_LEFT)).toBe(true);
		expect(isMonoChannelMode(CHANNEL_MODE_MONO_RIGHT)).toBe(true);
	});
});

describe('monoPickIndex', () => {
	it('returns null for non-picking modes', () => {
		expect(monoPickIndex(CHANNEL_MODE_SOURCE, 2)).toBeNull();
		expect(monoPickIndex(CHANNEL_MODE_MONO_MIX, 2)).toBeNull();
	});

	it('picks left and right on stereo input', () => {
		expect(monoPickIndex(CHANNEL_MODE_MONO_LEFT, 2)).toBe(0);
		expect(monoPickIndex(CHANNEL_MODE_MONO_RIGHT, 2)).toBe(1);
	});

	it('clamps the right pick to the only channel of mono input', () => {
		expect(monoPickIndex(CHANNEL_MODE_MONO_RIGHT, 1)).toBe(0);
	});

	it('never returns a negative index for degenerate channel counts', () => {
		expect(monoPickIndex(CHANNEL_MODE_MONO_LEFT, 0)).toBe(0);
		expect(monoPickIndex(CHANNEL_MODE_MONO_RIGHT, 0)).toBe(0);
	});
});

describe('downmixChannelData', () => {
	const left = Float32Array.from([0.5, -0.5, 1]);
	const right = Float32Array.from([-0.5, -0.5, 0]);

	it('averages all channels in the mix mode', () => {
		const mixed = downmixChannelData([left, right], CHANNEL_MODE_MONO_MIX);

		expect(Array.from(mixed)).toEqual([0, -0.5, 0.5]);
	});

	it('averages more than two channels', () => {
		const third = Float32Array.from([0.5, 0.5, 0.5]);
		const mixed = downmixChannelData(
			[left, right, third],
			CHANNEL_MODE_MONO_MIX,
		);

		expect(mixed[0]).toBeCloseTo(1 / 6);
		expect(mixed[1]).toBeCloseTo(-1 / 6);
		expect(mixed[2]).toBeCloseTo(0.5);
	});

	it('returns a copy of the picked channel', () => {
		const picked = downmixChannelData(
			[left, right],
			CHANNEL_MODE_MONO_RIGHT,
		);

		expect(Array.from(picked)).toEqual(Array.from(right));
		expect(picked).not.toBe(right);
	});

	it('falls back to the first channel for a right pick on mono data', () => {
		const picked = downmixChannelData([left], CHANNEL_MODE_MONO_RIGHT);

		expect(Array.from(picked)).toEqual(Array.from(left));
	});

	it('throws for the source mode and for empty data', () => {
		expect(() => downmixChannelData([left], CHANNEL_MODE_SOURCE)).toThrow();
		expect(() => downmixChannelData([], CHANNEL_MODE_MONO_MIX)).toThrow();
	});
});

describe('downmixAudioBuffer', () => {
	it('returns the buffer unchanged for the source mode', () => {
		const buffer = stereoBuffer([0.5], [-0.5]);

		expect(downmixAudioBuffer(buffer, CHANNEL_MODE_SOURCE)).toBe(buffer);
	});

	it('returns an already-mono buffer unchanged', () => {
		const mono = new FakeAudioBuffer({
			length: 2,
			numberOfChannels: 1,
			sampleRate: 48000,
		}) as unknown as AudioBuffer;

		expect(downmixAudioBuffer(mono, CHANNEL_MODE_MONO_MIX)).toBe(mono);
	});

	it('mixes a stereo buffer down to mono', () => {
		const buffer = stereoBuffer([0.5, 1], [-0.5, 0], 48000);

		const mono = downmixAudioBuffer(buffer, CHANNEL_MODE_MONO_MIX);

		expect(mono.numberOfChannels).toBe(1);
		expect(mono.sampleRate).toBe(48000);
		expect(mono).toHaveLength(2);
		expect(Array.from(mono.getChannelData(0))).toEqual([0, 0.5]);
	});

	it('keeps only the picked channel', () => {
		const buffer = stereoBuffer([0.5, 1], [-0.5, 0]);

		const mono = downmixAudioBuffer(buffer, CHANNEL_MODE_MONO_LEFT);

		expect(Array.from(mono.getChannelData(0))).toEqual([0.5, 1]);
	});
});
