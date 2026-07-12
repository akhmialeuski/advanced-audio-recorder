/**
 * Unit tests for the post-recording lopsided-stereo detector: the pure
 * channel-balance analysis and the decode wrapper around it.
 * @module tests/unit/silentChannelDetector.test
 */

import {
	analyzeChannelBalance,
	detectSilentChannel,
} from 'src/recording/silentChannelDetector';
import type { App, TFile } from 'obsidian';

/** Full-scale-ish tone; RMS ~0.35 (about -9 dBFS). */
function loud(length = 2048): Float32Array {
	const data = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		data[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
	}
	return data;
}

/** Effectively silent channel (well below the -60 dBFS floor). */
function silent(length = 2048): Float32Array {
	return new Float32Array(length);
}

/** Faint noise around -70 dBFS, still below the silence floor. */
function faint(length = 2048): Float32Array {
	return new Float32Array(length).fill(0.0002);
}

describe('analyzeChannelBalance', () => {
	it('flags a silent right channel and keeps the left', () => {
		const result = analyzeChannelBalance([loud(), silent()]);

		expect(result).toEqual({
			silentChannel: 1,
			audioChannel: 0,
			keepMode: 'mono-left',
		});
	});

	it('flags a silent left channel and keeps the right', () => {
		const result = analyzeChannelBalance([silent(), loud()]);

		expect(result).toEqual({
			silentChannel: 0,
			audioChannel: 1,
			keepMode: 'mono-right',
		});
	});

	it('treats a near-silent (noise-floor) channel as silent', () => {
		const result = analyzeChannelBalance([loud(), faint()]);

		expect(result?.silentChannel).toBe(1);
	});

	it('returns null for a balanced stereo signal', () => {
		expect(analyzeChannelBalance([loud(), loud()])).toBeNull();
	});

	it('returns null when both channels are silent', () => {
		expect(analyzeChannelBalance([silent(), silent()])).toBeNull();
	});

	it('returns null for mono and multichannel inputs', () => {
		expect(analyzeChannelBalance([loud()])).toBeNull();
		expect(analyzeChannelBalance([loud(), silent(), loud()])).toBeNull();
	});

	it('requires the gap to exceed the minimum before flagging', () => {
		// Quiet-but-present channel: below the loud one, but not by the
		// 40 dB gap and not under the silence floor
		const quiet = new Float32Array(2048).fill(0.02); // ~-34 dBFS
		expect(analyzeChannelBalance([loud(), quiet])).toBeNull();
	});

	it('honors custom floor and gap thresholds', () => {
		const quiet = new Float32Array(2048).fill(0.02);
		// Raise the floor above the quiet channel and shrink the gap
		const result = analyzeChannelBalance([loud(), quiet], -30, 10);
		expect(result?.silentChannel).toBe(1);
	});
});

describe('detectSilentChannel', () => {
	class FakeAudioBuffer {
		constructor(
			public numberOfChannels: number,
			public duration: number,
			private readonly channels: Float32Array[],
		) {}
		getChannelData(index: number): Float32Array {
			return this.channels[index] ?? new Float32Array();
		}
	}

	let decodeAudioData: jest.Mock;
	let close: jest.Mock;

	function makeApp(bytes = new ArrayBuffer(64)): App {
		return {
			vault: { readBinary: jest.fn().mockResolvedValue(bytes) },
		} as unknown as App;
	}

	const file = { path: 'rec.wav' } as unknown as TFile;

	beforeEach(() => {
		decodeAudioData = jest.fn();
		close = jest.fn().mockResolvedValue(undefined);
		(global as Record<string, unknown>).AudioContext = jest
			.fn()
			.mockImplementation(() => ({ decodeAudioData, close }));
	});

	it('detects a lopsided stereo recording', async () => {
		decodeAudioData.mockResolvedValue(
			new FakeAudioBuffer(2, 5, [loud(), silent()]),
		);

		const result = await detectSilentChannel(makeApp(), file);

		expect(result?.keepMode).toBe('mono-left');
		expect(close).toHaveBeenCalled();
	});

	it('returns null and closes the context for a mono file', async () => {
		decodeAudioData.mockResolvedValue(new FakeAudioBuffer(1, 5, [loud()]));

		expect(await detectSilentChannel(makeApp(), file)).toBeNull();
		expect(close).toHaveBeenCalled();
	});

	it('skips files longer than the decode cap', async () => {
		decodeAudioData.mockResolvedValue(
			new FakeAudioBuffer(2, 3600, [loud(), silent()]),
		);

		expect(await detectSilentChannel(makeApp(), file, 60)).toBeNull();
	});

	it('returns null and closes the context when decoding fails', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		decodeAudioData.mockRejectedValue(new Error('bad data'));

		expect(await detectSilentChannel(makeApp(), file)).toBeNull();
		expect(close).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('returns null when the file cannot be read', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		const app = {
			vault: {
				readBinary: jest.fn().mockRejectedValue(new Error('missing')),
			},
		} as unknown as App;

		expect(await detectSilentChannel(app, file)).toBeNull();
		warn.mockRestore();
	});
});
