/**
 * Tests for the audio preparation helpers: extension-to-MIME mapping,
 * capability-derived prep options, the cheap whole-file path (sending the
 * original bytes untouched), the duration-cap proof, and the decode/split
 * path. The real decode needs the Web Audio API, so `decodeToMono16k` is
 * mocked to return synthetic samples of a chosen length; the chunk planning
 * and WAV encoding around it run for real.
 */

jest.mock('src/transcription/audioChunks', () => {
	const actual = jest.requireActual<
		typeof import('src/transcription/audioChunks')
	>('src/transcription/audioChunks');
	return { ...actual, decodeToMono16k: jest.fn() };
});

import {
	audioMimeFromExtension,
	audioPrepOptions,
	prepareAudio,
	shouldWarnDiarizationSplit,
	withinDurationCap,
} from 'src/transcription/audioPrep';
import { at } from '../helpers/assertions';
import { decodeToMono16k } from 'src/transcription/audioChunks';
import {
	TRANSCRIBE_BYTES_PER_SEC,
	TRANSCRIBE_SAMPLE_RATE,
} from 'src/constants';
import { WAV_HEADER_SIZE } from 'src/audio/WavEncoder';
import type { ProviderCapabilities } from 'src/transcription/providers/TranscriptionProvider';

const decodeMock = jest.mocked(decodeToMono16k);

/** Synthetic 16 kHz mono samples spanning the given number of seconds. */
function samplesForSeconds(seconds: number): Float32Array {
	return new Float32Array(seconds * TRANSCRIBE_SAMPLE_RATE);
}

/** A chunk byte budget that yields parts of exactly `seconds` each. */
function chunkBudgetForSeconds(seconds: number): number {
	return WAV_HEADER_SIZE + seconds * TRANSCRIBE_BYTES_PER_SEC;
}

beforeEach(() => {
	decodeMock.mockReset();
});

describe('audioMimeFromExtension', () => {
	it('maps known extensions to container MIME types', () => {
		expect(audioMimeFromExtension('mp3')).toBe('audio/mpeg');
		expect(audioMimeFromExtension('wav')).toBe('audio/wav');
		expect(audioMimeFromExtension('m4a')).toBe('audio/mp4');
		expect(audioMimeFromExtension('webm')).toBe('audio/webm');
		expect(audioMimeFromExtension('flac')).toBe('audio/flac');
	});

	it('is case-insensitive', () => {
		expect(audioMimeFromExtension('WAV')).toBe('audio/wav');
	});

	it('defaults to audio/<ext> for unmapped extensions', () => {
		expect(audioMimeFromExtension('opus')).toBe('audio/opus');
	});
});

describe('withinDurationCap', () => {
	it('is always satisfied by an infinite cap', () => {
		expect(
			withinDurationCap(
				Number.MAX_SAFE_INTEGER,
				Number.POSITIVE_INFINITY,
			),
		).toBe(true);
	});

	it('proves a small file is within a finite cap', () => {
		// 900 s cap admits up to 900_000 bytes at the conservative min bitrate.
		expect(withinDurationCap(500_000, 900)).toBe(true);
		expect(withinDurationCap(900_000, 900)).toBe(true);
	});

	it('cannot prove a larger file short (falls through to decode)', () => {
		expect(withinDurationCap(900_001, 900)).toBe(false);
		expect(withinDurationCap(65 * 1024 * 1024, 900)).toBe(false);
	});
});

describe('audioPrepOptions', () => {
	const networkCaps: ProviderCapabilities = {
		maxRequestBytes: 25 * 1024 * 1024,
		maxRequestSeconds: Number.POSITIVE_INFINITY,
		acceptsOriginalContainer: true,
		supportsDiarization: false,
		supportsDictionary: false,
	};

	it('bounds the chunk size by the provider limit for network providers', () => {
		const options = audioPrepOptions(
			networkCaps,
			true,
			100 * 1024 * 1024,
			false,
		);
		expect(options.chunkBytes).toBe(25 * 1024 * 1024);
		expect(options.maxRequestBytes).toBe(25 * 1024 * 1024);
		expect(options.maxRequestSeconds).toBe(Number.POSITIVE_INFINITY);
		expect(options.acceptsOriginalContainer).toBe(true);
	});

	it('uses the user chunk size when it is under the provider limit', () => {
		const options = audioPrepOptions(
			networkCaps,
			true,
			10 * 1024 * 1024,
			false,
		);
		expect(options.chunkBytes).toBe(10 * 1024 * 1024);
	});

	it('produces a single chunk for an unbounded local provider', () => {
		const localCaps: ProviderCapabilities = {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: false,
			supportsDiarization: false,
			supportsDictionary: false,
		};
		const options = audioPrepOptions(
			localCaps,
			false,
			10 * 1024 * 1024,
			false,
		);
		expect(options.chunkBytes).toBe(Number.POSITIVE_INFINITY);
	});

	it('sizes parts by the duration cap, ignoring the user chunk size', () => {
		// A duration-capped provider chunks by time, not the user's MB setting.
		const cappedCaps: ProviderCapabilities = {
			maxRequestBytes: 2 * 1024 * 1024 * 1024,
			maxRequestSeconds: 900,
			acceptsOriginalContainer: true,
			supportsDiarization: true,
			supportsDictionary: false,
		};
		const options = audioPrepOptions(
			cappedCaps,
			true,
			24 * 1024 * 1024,
			true,
		);
		expect(options.chunkBytes).toBe(900 * TRANSCRIBE_BYTES_PER_SEC);
		expect(options.maxRequestSeconds).toBe(900);
	});

	it('carries the diarization flag and request limits through', () => {
		const diarizingCaps: ProviderCapabilities = {
			maxRequestBytes: 1000,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: true,
			supportsDictionary: false,
		};
		const options = audioPrepOptions(diarizingCaps, true, 1000, true);
		expect(options.diarize).toBe(true);
		expect(options.maxRequestSeconds).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('shouldWarnDiarizationSplit', () => {
	it('warns when a diarized run is split into parts', () => {
		expect(shouldWarnDiarizationSplit(2, true)).toBe(true);
	});

	it('does not warn for a single part', () => {
		expect(shouldWarnDiarizationSplit(1, true)).toBe(false);
	});

	it('does not warn when diarization was not requested', () => {
		expect(shouldWarnDiarizationSplit(3, false)).toBe(false);
	});
});

describe('prepareAudio (whole-file path)', () => {
	it('sends the original bytes untouched when within the limits', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
			diarize: false,
		});
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).createData()).toBe(raw);
		expect(at(result.payloads, 0).contentType).toBe('audio/webm');
		expect(at(result.payloads, 0).filename).toBe('rec.webm');
		expect(at(result.payloads, 0).offsetSeconds).toBe(0);
		expect(decodeMock).not.toHaveBeenCalled();
	});

	it('does not flag a diarization split when the whole file is sent', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
			diarize: true,
		});
		expect(result.diarizationSplitWarning).toBe(false);
	});

	it('sends a short file whole when the byte size proves it within the cap', async () => {
		const raw = new Uint8Array(500).buffer;
		const result = await prepareAudio(raw, 'rec.mp3', 'audio/mpeg', {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 900,
			acceptsOriginalContainer: true,
			chunkBytes: 900 * TRANSCRIBE_BYTES_PER_SEC,
			diarize: true,
		});
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).createData()).toBe(raw);
		expect(result.diarizationSplitWarning).toBe(false);
		expect(decodeMock).not.toHaveBeenCalled();
	});
});

describe('prepareAudio (duration-cap decode path)', () => {
	it('decodes and splits a recording too long for one request, even within the byte limit', async () => {
		// 6 s of audio, parts of 2 s each: the byte size fits the limit but the
		// duration cap (2 s here) forces a decode-and-split into three parts.
		decodeMock.mockResolvedValue(samplesForSeconds(6));
		const raw = new Uint8Array(50_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', 'audio/mp4', {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 2,
			acceptsOriginalContainer: true,
			chunkBytes: chunkBudgetForSeconds(2),
			diarize: true,
		});
		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(result.payloads).toHaveLength(3);
		expect(result.payloads.map((p) => p.offsetSeconds)).toEqual([0, 2, 4]);
		expect(result.payloads.map((p) => p.filename)).toEqual([
			'audio-0.wav',
			'audio-1.wav',
			'audio-2.wav',
		]);
		expect(at(result.payloads, 0).contentType).toBe('audio/wav');
		expect(result.diarizationSplitWarning).toBe(true);
	});

	it('does not warn about speakers when diarization is off', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(6));
		const raw = new Uint8Array(50_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', 'audio/mp4', {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 2,
			acceptsOriginalContainer: true,
			chunkBytes: chunkBudgetForSeconds(2),
			diarize: false,
		});
		expect(result.payloads).toHaveLength(3);
		expect(result.diarizationSplitWarning).toBe(false);
	});

	it('emits a single decoded part when the recording still fits the cap', async () => {
		// A 2 MB file exceeds the cheap byte proof (900 s admits < 0.9 MB), so it
		// is decoded; the measured duration then fits one part, so there is no
		// split and no speaker warning.
		decodeMock.mockResolvedValue(samplesForSeconds(2));
		const raw = new Uint8Array(2_000_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', 'audio/mp4', {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 900,
			acceptsOriginalContainer: true,
			chunkBytes: chunkBudgetForSeconds(900),
			diarize: true,
		});
		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).filename).toBe('audio.wav');
		expect(result.diarizationSplitWarning).toBe(false);
	});
});
