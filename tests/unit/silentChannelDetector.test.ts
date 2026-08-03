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
import { createMockApp } from '../helpers/createApp';

// Only the probe is doubled: the ceiling predicate beside it is a pure rule
// both this detector and the cleanup guard read, and a blank stub for it would
// test the mock rather than the rule.
jest.mock('src/utils/AudioFileAnalyzer', () => ({
	...jest.requireActual<typeof import('src/utils/AudioFileAnalyzer')>(
		'src/utils/AudioFileAnalyzer',
	),
	probeAudioMetadata: jest.fn(),
}));

const { probeAudioMetadata } = jest.requireMock('src/utils/AudioFileAnalyzer');

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
		const result = analyzeChannelBalance([loud(), quiet], {
			floorDb: -30,
			minGapDb: 10,
		});
		expect(result?.silentChannel).toBe(1);
	});

	it('preserves a channel containing a short real signal', () => {
		const continuous = new Float32Array(4096).fill(0.3);
		const sparse = new Float32Array(4096);
		sparse.set(new Float32Array(256).fill(0.2), 2048);

		expect(
			analyzeChannelBalance([continuous, sparse], { windowFrames: 256 }),
		).toBeNull();
	});

	it('does not treat tiny device noise as the audio channel', () => {
		const almostSilent = new Float32Array(2048).fill(
			Math.pow(10, -59 / 20),
		);

		expect(analyzeChannelBalance([almostSilent, silent()])).toBeNull();
	});
});

describe('detectSilentChannel', () => {
	class FakeAudioBuffer {
		constructor(
			public numberOfChannels: number,
			public duration: number,
			private readonly channels: Float32Array[],
			public sampleRate = 44100,
		) {}
		getChannelData(index: number): Float32Array {
			return this.channels[index] ?? new Float32Array();
		}
	}

	let decodeAudioData: jest.Mock;
	let close: jest.Mock;

	function makeApp(bytes = new ArrayBuffer(64)): App {
		return createMockApp({
			vault: { readBinary: jest.fn().mockResolvedValue(bytes) },
		}).app;
	}

	const file = { path: 'rec.wav' } as unknown as TFile;

	beforeEach(() => {
		(probeAudioMetadata as jest.Mock).mockReset().mockResolvedValue({
			durationSeconds: 5,
			sampleRate: 44100,
			channels: 2,
		});
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
		(probeAudioMetadata as jest.Mock).mockResolvedValue({
			durationSeconds: 5,
			sampleRate: 44100,
			channels: 1,
		});
		const app = makeApp();

		expect(await detectSilentChannel(app, file)).toBeNull();
		expect(decodeAudioData).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('skips a known long recording before reading or decoding it', async () => {
		const app = makeApp();

		expect(
			await detectSilentChannel(app, file, {
				knownDurationSeconds: 3600,
				maxDecodeSeconds: 60,
			}),
		).toBeNull();
		expect(app.vault.readBinary).not.toHaveBeenCalled();
		expect(probeAudioMetadata).not.toHaveBeenCalled();
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it('skips a long file from metadata before full decode', async () => {
		(probeAudioMetadata as jest.Mock).mockResolvedValue({
			durationSeconds: 3600,
			sampleRate: 44100,
			channels: 2,
		});

		expect(
			await detectSilentChannel(makeApp(), file, {
				maxDecodeSeconds: 60,
			}),
		).toBeNull();
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it('keeps the decoded-duration guard when the headers carried no length', async () => {
		// The headers parsed and reported two channels, but no length. Reading
		// that as zero seconds would call a multi-hour recording short enough
		// to decode, so the guard defers to the post-decode check instead.
		(probeAudioMetadata as jest.Mock).mockResolvedValue({
			durationSeconds: null,
			sampleRate: 44100,
			channels: 2,
		});
		decodeAudioData.mockResolvedValue(
			new FakeAudioBuffer(2, 3600, [loud(), silent()]),
		);

		expect(
			await detectSilentChannel(makeApp(), file, {
				maxDecodeSeconds: 60,
			}),
		).toBeNull();
		expect(decodeAudioData).toHaveBeenCalled();
	});

	it('keeps the decoded-duration guard when metadata is unavailable', async () => {
		(probeAudioMetadata as jest.Mock).mockResolvedValue(null);
		decodeAudioData.mockResolvedValue(
			new FakeAudioBuffer(2, 3600, [loud(), silent()]),
		);

		expect(
			await detectSilentChannel(makeApp(), file, {
				maxDecodeSeconds: 60,
			}),
		).toBeNull();
		expect(close).toHaveBeenCalled();
	});

	it('returns null and closes the context when decoding fails', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		(probeAudioMetadata as jest.Mock).mockResolvedValue(null);
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
