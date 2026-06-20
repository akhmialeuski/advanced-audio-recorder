/**
 * Tests for the audio preparation helpers: extension-to-MIME mapping,
 * capability-derived prep options, and the whole-file path (sending the
 * original bytes untouched). The decode path is exercised indirectly via
 * planChunks tests, since decoding needs the Web Audio API.
 */

import {
	audioMimeFromExtension,
	audioPrepOptions,
	prepareAudio,
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
		const options = audioPrepOptions(networkCaps, true, 100 * 1024 * 1024);
		expect(options.chunkBytes).toBe(25 * 1024 * 1024);
		expect(options.maxRequestBytes).toBe(25 * 1024 * 1024);
		expect(options.acceptsOriginalContainer).toBe(true);
	});

	it('uses the user chunk size when it is under the provider limit', () => {
		const options = audioPrepOptions(networkCaps, true, 10 * 1024 * 1024);
		expect(options.chunkBytes).toBe(10 * 1024 * 1024);
	});

	it('produces a single chunk for an unbounded local provider', () => {
		const localCaps: ProviderCapabilities = {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: false,
			diarizesWholeFile: false,
		};
		const options = audioPrepOptions(localCaps, false, 10 * 1024 * 1024);
		expect(options.chunkBytes).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('prepareAudio (whole-file path)', () => {
	it('sends the original bytes untouched when within the limit', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', 'audio/webm', {
			maxRequestBytes: 1000,
			acceptsOriginalContainer: true,
			chunkBytes: 1000,
		});
		expect(result.totalSeconds).toBeNull();
		expect(result.payloads).toHaveLength(1);
		expect(result.payloads[0].data).toBe(raw);
		expect(result.payloads[0].contentType).toBe('audio/webm');
		expect(result.payloads[0].filename).toBe('rec.webm');
		expect(result.payloads[0].offsetSeconds).toBe(0);
	});
});
