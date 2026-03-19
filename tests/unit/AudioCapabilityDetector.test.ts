/**
 * Unit tests for AudioCapabilityDetector module.
 * Tests format detection, MIME type building, and pre-recording validation.
 * @module tests/unit/AudioCapabilityDetector.test
 */
/** @jest-environment jsdom */

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('../../src/recording/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return ['mp3', 'flac', 'aac'].includes(format);
	}),
}));

import {
	buildMimeType,
	detectSupportedFormats,
	getSupportedSampleRates,
	getSupportedBitrates,
	validateRecordingCapability,
	detectCapabilities,
	detectCodecSupport,
	FORMAT_FLAC,
} from '../../src/recording/AudioCapabilityDetector';

describe('AudioCapabilityDetector', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('buildMimeType', () => {
		it('should return plain audio/webm without codecs suffix', () => {
			expect(buildMimeType('webm')).toBe('audio/webm');
		});

		it('should return plain audio/ogg without codecs suffix', () => {
			expect(buildMimeType('ogg')).toBe('audio/ogg');
		});

		it('should return plain audio/mp3', () => {
			expect(buildMimeType('mp3')).toBe('audio/mp3');
		});

		it('should return plain audio/m4a', () => {
			expect(buildMimeType('m4a')).toBe('audio/m4a');
		});

		it('should handle arbitrary format strings', () => {
			expect(buildMimeType(FORMAT_FLAC)).toBe(`audio/${FORMAT_FLAC}`);
		});
	});

	describe('detectSupportedFormats', () => {
		it('should return MediaRecorder formats plus offline-only formats', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm' || type === 'audio/ogg';
				}),
			};

			const formats = detectSupportedFormats();

			expect(formats).toContain('webm');
			expect(formats).toContain('ogg');
			// Offline-only formats are also included when their encoder is available
			expect(formats).toContain('mp3');
			expect(formats).toContain('flac');
			expect(formats).toContain('aac');
		});

		it('should include wav when a compressed intermediate is supported', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm';
				}),
			};

			const formats = detectSupportedFormats();

			expect(formats).toContain('wav');
			expect(formats).toContain('webm');
		});

		it('should exclude wav when no compressed intermediate is supported', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/mp3';
				}),
			};

			const formats = detectSupportedFormats();

			expect(formats).toContain('mp3');
			expect(formats).not.toContain('wav');
		});

		it('should return only offline-only formats when MediaRecorder supports nothing', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const formats = detectSupportedFormats();

			// No MediaRecorder formats, but offline-only encoders are still available
			expect(formats).not.toContain('webm');
			expect(formats).not.toContain('ogg');
			expect(formats).not.toContain('wav');
			expect(formats).toContain('mp3');
			expect(formats).toContain('flac');
			expect(formats).toContain('aac');
		});
	});

	describe('getSupportedSampleRates', () => {
		it('should return all candidate sample rates', () => {
			const rates = getSupportedSampleRates();

			expect(rates).toEqual([8000, 16000, 22050, 44100, 48000]);
		});

		it('should return a new array each time', () => {
			const rates1 = getSupportedSampleRates();
			const rates2 = getSupportedSampleRates();

			expect(rates1).not.toBe(rates2);
			expect(rates1).toEqual(rates2);
		});
	});

	describe('getSupportedBitrates', () => {
		it('should return all candidate bitrates in bps', () => {
			const bitrates = getSupportedBitrates();

			expect(bitrates).toEqual([
				64000, 96000, 128000, 160000, 192000, 256000, 320000,
			]);
		});

		it('should return a new array each time', () => {
			const b1 = getSupportedBitrates();
			const b2 = getSupportedBitrates();

			expect(b1).not.toBe(b2);
			expect(b1).toEqual(b2);
		});
	});

	describe('validateRecordingCapability', () => {
		beforeEach(() => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm' || type === 'audio/ogg';
				}),
			};
		});

		it('should return valid for supported format', () => {
			const result = validateRecordingCapability('webm');

			expect(result.valid).toBe(true);
			expect(result.reason).toBe('');
		});

		it('should return valid for offline-only format when intermediate is available', () => {
			const result = validateRecordingCapability('mp3');

			// MP3 is offline-only but valid because WebM intermediate is supported
			expect(result.valid).toBe(true);
		});

		it('should return invalid for completely unsupported format', () => {
			const result = validateRecordingCapability('xyz');

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('xyz');
			expect(result.reason).toContain('not supported');
		});

		it('should return valid for wav when compressed intermediate is available', () => {
			const result = validateRecordingCapability('wav');

			expect(result.valid).toBe(true);
		});

		it('should return invalid for wav when no compressed intermediate is available', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const result = validateRecordingCapability('wav');

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('WAV output requires');
		});
	});

	describe('detectCapabilities', () => {
		it('should aggregate all detection results', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm';
				}),
			};

			const caps = detectCapabilities();

			expect(caps.supportedFormats).toContain('webm');
			expect(caps.supportedFormats).toContain('wav');
			expect(caps.supportedSampleRates).toEqual([
				8000, 16000, 22050, 44100, 48000,
			]);
			expect(caps.supportedBitrates.length).toBeGreaterThan(0);
			expect(caps.defaultFormat).toBe('webm');
			expect(caps.defaultSampleRate).toBe(44100);
			expect(caps.defaultBitrate).toBe(128000);
		});

		it('should default to first supported format when webm is unavailable', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/ogg';
				}),
			};

			const caps = detectCapabilities();

			expect(caps.defaultFormat).toBe('ogg');
		});

		it('should default to first available format when nothing is supported by MediaRecorder', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const caps = detectCapabilities();

			// Only offline-only formats available; first one is the default
			expect(caps.supportedFormats.length).toBeGreaterThan(0);
			expect(caps.defaultFormat).toBe(caps.supportedFormats[0]);
		});
	});

	describe('detectCodecSupport', () => {
		it('returns an entry for each candidate format', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/webm',
				),
			};

			const entries = detectCodecSupport();

			// CANDIDATE_FORMATS = ['webm', 'ogg', 'mp3', 'm4a', 'mp4']
			expect(entries).toHaveLength(5);
		});

		it('sets supported=true only for the MIME type that matches', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/webm',
				),
			};

			const entries = detectCodecSupport();
			const webm = entries.find((e) => e.mimeType === 'audio/webm');
			const ogg = entries.find((e) => e.mimeType === 'audio/ogg');

			expect(webm?.supported).toBe(true);
			expect(ogg?.supported).toBe(false);
		});

		it('populates withCodecs with correct mimeType strings', () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) =>
						type === 'audio/webm' ||
						type === 'audio/webm;codecs=opus',
				),
			};

			const entries = detectCodecSupport();
			const webm = entries.find((e) => e.mimeType === 'audio/webm');

			expect(webm).toBeDefined();
			const opusEntry = webm?.withCodecs.find((c) => c.codec === 'opus');
			expect(opusEntry?.mimeType).toBe('audio/webm;codecs=opus');
			expect(opusEntry?.supported).toBe(true);

			const vorbisEntry = webm?.withCodecs.find(
				(c) => c.codec === 'vorbis',
			);
			expect(vorbisEntry?.supported).toBe(false);
		});

		it('returns supported=false for all when MediaRecorder is unavailable', () => {
			(global as Record<string, unknown>).MediaRecorder = undefined;

			const entries = detectCodecSupport();

			entries.forEach((entry) => {
				expect(entry.supported).toBe(false);
				entry.withCodecs.forEach((v) => {
					expect(v.supported).toBe(false);
				});
			});
		});
	});
});
