/**
 * Tests for the audio preparation helpers: extension-to-MIME mapping,
 * capability-derived prep options, the whole-file path (sending the
 * original bytes untouched), and the whole-file diarization guard. The
 * decode path is exercised indirectly via planChunks tests, since decoding
 * needs the Web Audio API.
 */

import {
	audioMimeFromExtension,
	audioPrepOptions,
	prepareAudio,
	shouldWarnDiarizationSplit,
	WholeFileDiarizationLimitError,
} from 'src/transcription/audioPrep';
import type { ProviderCapabilities } from 'src/transcription/providers/TranscriptionProvider';

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

describe('audioPrepOptions', () => {
	const networkCaps: ProviderCapabilities = {
		maxRequestBytes: 25 * 1024 * 1024,
		acceptsOriginalContainer: true,
		diarizesWholeFile: false,
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
			acceptsOriginalContainer: false,
			diarizesWholeFile: false,
		};
		const options = audioPrepOptions(
			localCaps,
			false,
			10 * 1024 * 1024,
			false,
		);
		expect(options.chunkBytes).toBe(Number.POSITIVE_INFINITY);
	});

	it('carries the diarization flags through', () => {
		const diarizingCaps: ProviderCapabilities = {
			maxRequestBytes: 1000,
			acceptsOriginalContainer: true,
			diarizesWholeFile: true,
		};
		const options = audioPrepOptions(diarizingCaps, true, 1000, true);
		expect(options.diarize).toBe(true);
		expect(options.diarizesWholeFile).toBe(true);
	});
});

describe('shouldWarnDiarizationSplit', () => {
	it('warns when a diarized run is split on a per-request-numbering provider', () => {
		expect(shouldWarnDiarizationSplit(2, true, false)).toBe(true);
	});

	it('does not warn for a single chunk', () => {
		expect(shouldWarnDiarizationSplit(1, true, false)).toBe(false);
	});

	it('does not warn when diarization was not requested', () => {
		expect(shouldWarnDiarizationSplit(3, false, false)).toBe(false);
	});

	it('does not warn for a provider that diarizes the whole request', () => {
		expect(shouldWarnDiarizationSplit(3, true, true)).toBe(false);
	});
});

describe('prepareAudio (whole-file path)', () => {
	it('sends the original bytes untouched when within the limit', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
			diarize: false,
			diarizesWholeFile: false,
		});
		expect(result.payloads).toHaveLength(1);
		expect(result.payloads[0].createData()).toBe(raw);
		expect(result.payloads[0].contentType).toBe('audio/webm');
		expect(result.payloads[0].filename).toBe('rec.webm');
		expect(result.payloads[0].offsetSeconds).toBe(0);
	});

	it('does not flag a diarization split when the whole file is sent', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
			diarize: true,
			diarizesWholeFile: false,
		});
		expect(result.diarizationSplitWarning).toBe(false);
	});

	it('sends the whole file even when diarizing, as long as it fits', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
			diarize: true,
			diarizesWholeFile: true,
		});
		expect(result.payloads).toHaveLength(1);
		expect(result.payloads[0].createData()).toBe(raw);
	});
});

describe('prepareAudio (whole-file diarization guard)', () => {
	it('refuses to chunk a too-large file for a whole-file diarizing provider', async () => {
		const raw = new Uint8Array(2048).buffer;
		await expect(
			prepareAudio(raw, 'rec.webm', 'audio/webm', {
				maxRequestBytes: 1024,
				acceptsOriginalContainer: true,
				chunkBytes: 512,
				diarize: true,
				diarizesWholeFile: true,
			}),
		).rejects.toBeInstanceOf(WholeFileDiarizationLimitError);
	});
});
