/**
 * Unit tests for AudioCapabilityDetector module.
 * Tests format detection, MIME type building, and pre-recording validation.
 * @module tests/unit/AudioCapabilityDetector.test
 */

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement.
// The probe answers like a desktop with the bundled mp3/flac extension
// encoders plus a WebCodecs AAC encoder.
jest.mock('src/audio/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return ['mp3', 'flac', 'aac'].includes(format);
	}),
	probeOfflineEncodingSupport: jest.fn((format: string) =>
		Promise.resolve(['mp3', 'flac', 'aac'].includes(format)),
	),
}));

import { FORMAT_FLAC } from 'src/constants';
import {
	buildMimeType,
	detectSupportedFormats,
	getSupportedSampleRates,
	getSupportedBitrates,
	validateRecordingCapability,
	detectCapabilities,
	detectCodecSupport,
	listFormatAvailability,
	resolveEffectiveOutputFormat,
} from 'src/audio/AudioCapabilityDetector';
import { setPlatform, useDesktopPlatform } from '../helpers/platform';

describe('AudioCapabilityDetector', () => {
	describe('buildMimeType', () => {
		// No codecs suffix for any of them: MediaRecorder is asked about the
		// container, and pinning a codec narrows what the browser will accept.
		it.each([
			{ format: 'webm', expected: 'audio/webm' },
			{ format: 'ogg', expected: 'audio/ogg' },
			{ format: 'mp3', expected: 'audio/mp3' },
			{ format: 'm4a', expected: 'audio/m4a' },
			{ format: 'mp4', expected: 'audio/mp4' },
			{ format: 'wav', expected: 'audio/wav' },
			{ format: FORMAT_FLAC, expected: `audio/${FORMAT_FLAC}` },
			{ format: 'anything', expected: 'audio/anything' },
		])('maps $format to $expected', ({ format, expected }) => {
			expect(buildMimeType(format)).toBe(expected);
		});
	});

	describe('detectSupportedFormats', () => {
		it('returns MediaRecorder formats plus offline-encodable formats', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm' || type === 'audio/ogg';
				}),
			};

			const formats = await detectSupportedFormats();

			expect(formats).toContain('webm');
			expect(formats).toContain('ogg');
			// Formats with a probed working encoder ride the intermediate
			expect(formats).toContain('mp3');
			expect(formats).toContain('flac');
			expect(formats).toContain('aac');
		});

		it('includes wav when a compressed intermediate is supported', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm';
				}),
			};

			const formats = await detectSupportedFormats();

			expect(formats).toContain('wav');
			expect(formats).toContain('webm');
		});

		it('excludes wav when no compressed intermediate is supported', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/mp3';
				}),
			};

			const formats = await detectSupportedFormats();

			expect(formats).toContain('mp3');
			expect(formats).not.toContain('wav');
		});

		it('returns nothing when MediaRecorder supports no format at all', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const formats = await detectSupportedFormats();

			// Without a recordable container there is nothing to encode
			// offline from, so no format is recordable - a working
			// encoder alone records nothing.
			expect(formats).toEqual([]);
		});
	});

	describe('getSupportedSampleRates', () => {
		it('returns all candidate sample rates', () => {
			const rates = getSupportedSampleRates();

			expect(rates).toEqual([8000, 16000, 22050, 44100, 48000]);
		});

		it('returns a new array each time', () => {
			const rates1 = getSupportedSampleRates();
			const rates2 = getSupportedSampleRates();

			expect(rates1).not.toBe(rates2);
			expect(rates1).toEqual(rates2);
		});
	});

	describe('getSupportedBitrates', () => {
		it('returns all candidate bitrates in bps', () => {
			const bitrates = getSupportedBitrates();

			expect(bitrates).toEqual([
				64000, 96000, 128000, 160000, 192000, 256000, 320000,
			]);
		});

		it('returns a new array each time', () => {
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

		it('returns valid for supported format', async () => {
			const result = await validateRecordingCapability('webm');

			expect(result.valid).toBe(true);
			expect(result.reason).toBe('');
		});

		it('returns valid for offline-only format when intermediate is available', async () => {
			const result = await validateRecordingCapability('mp3');

			// MP3 is offline-only but valid because WebM intermediate is supported
			expect(result.valid).toBe(true);
		});

		it('returns invalid for completely unsupported format', async () => {
			const result = await validateRecordingCapability('xyz');

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('xyz');
			expect(result.reason).toContain('cannot be recorded or encoded');
		});

		it('returns invalid when the encoder probe fails despite an intermediate', async () => {
			// m4a needs a working AAC-in-mp4 pipeline; the mock probe
			// rejects it, so the intermediate alone must not validate it
			const result = await validateRecordingCapability('m4a');

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('m4a');
		});

		it('returns valid for wav when compressed intermediate is available', async () => {
			const result = await validateRecordingCapability('wav');

			expect(result.valid).toBe(true);
		});

		it('returns invalid for wav when no compressed intermediate is available', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const result = await validateRecordingCapability('wav');

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('WAV output requires');
		});
	});

	describe('detectCapabilities', () => {
		it('aggregates all detection results', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/webm';
				}),
			};

			const caps = await detectCapabilities();

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

		it('defaults to first supported format when webm is unavailable', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn((type: string) => {
					return type === 'audio/ogg';
				}),
			};

			const caps = await detectCapabilities();

			expect(caps.defaultFormat).toBe('ogg');
		});

		it('reports no supported formats when nothing can be recorded', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			const caps = await detectCapabilities();

			expect(caps.supportedFormats).toEqual([]);
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

	describe('platform-aware WAV availability', () => {
		afterEach(() => {
			useDesktopPlatform();
			delete (global as Record<string, unknown>).AudioContext;
		});

		it('offers WAV on desktop via PCM capture without any intermediate', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};
			(global as Record<string, unknown>).AudioContext = jest.fn();

			expect(await detectSupportedFormats()).toContain('wav');
			expect((await validateRecordingCapability('wav')).valid).toBe(true);
		});

		it('blocks WAV on mobile when no intermediate is recordable', async () => {
			// PCM capture is desktop-only, so AudioContext alone is not
			// enough on mobile - an intermediate recording format is needed
			setPlatform({ isMobile: true });
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};
			(global as Record<string, unknown>).AudioContext = jest.fn();

			expect(await detectSupportedFormats()).not.toContain('wav');
			const result = await validateRecordingCapability('wav');
			expect(result.valid).toBe(false);
			expect(result.reason).toMatch(/neither is available/);
		});

		it('offers WAV on mobile through the mp4 intermediate (iOS)', async () => {
			// iOS WKWebView records audio/mp4 only
			setPlatform({ isMobile: true });
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/mp4',
				),
			};

			expect(await detectSupportedFormats()).toContain('wav');
			expect((await validateRecordingCapability('wav')).valid).toBe(true);
			// Offline-only formats ride the same intermediate
			expect((await validateRecordingCapability('mp3')).valid).toBe(true);
		});
	});

	describe('resolveEffectiveOutputFormat', () => {
		afterEach(() => {
			useDesktopPlatform();
		});

		it('keeps a recordable requested format', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/webm',
				),
			};

			const effective = await resolveEffectiveOutputFormat('WEBM');

			expect(effective).toEqual({
				format: 'webm',
				fellBack: false,
				reason: '',
			});
		});

		it('falls back to the platform default when the request is unrecordable (iOS default-webm case)', async () => {
			// The plugin default (webm) synced onto an iOS profile that can
			// only record audio/mp4 and has no working opus encoder
			setPlatform({ isMobile: true });
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/mp4',
				),
			};

			const effective = await resolveEffectiveOutputFormat('webm');

			expect(effective.fellBack).toBe(true);
			expect(effective.format).toBe('mp4');
			expect(effective.reason).not.toBe('');
		});

		it('throws when this device cannot record any format at all', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			await expect(resolveEffectiveOutputFormat('webm')).rejects.toThrow(
				/webm/,
			);
		});
	});

	describe('listFormatAvailability', () => {
		afterEach(() => {
			useDesktopPlatform();
		});

		it('reports every registry format with its availability (iOS profile)', async () => {
			setPlatform({ isMobile: true });
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) => type === 'audio/mp4',
				),
			};

			const entries = await listFormatAvailability();
			const byFormat = new Map(
				entries.map((entry) => [entry.format, entry]),
			);

			// The list covers the full registry, in registry order
			expect(entries.map((entry) => entry.format)).toEqual([
				'wav',
				'webm',
				'ogg',
				'mp3',
				'm4a',
				'mp4',
				'flac',
				'aac',
			]);
			// audio/mp4 is directly recordable
			expect(byFormat.get('mp4')).toMatchObject({
				available: true,
				direct: true,
			});
			// m4a records through its canonical audio/mp4 container MIME
			expect(byFormat.get('m4a')).toMatchObject({
				available: true,
				direct: true,
			});
			// WAV and mp3 work through the mp4 intermediate + offline encode
			expect(byFormat.get('wav')).toMatchObject({
				available: true,
				direct: false,
			});
			expect(byFormat.get('mp3')).toMatchObject({
				available: true,
				direct: false,
			});
			// Opus containers cannot be produced at all on this profile
			// (no direct support, and webm/ogg offline encoders are absent
			// in this suite's AudioEncoder mock)
			expect(byFormat.get('webm')).toMatchObject({
				available: false,
				direct: false,
			});
			expect(byFormat.get('ogg')).toMatchObject({
				available: false,
				direct: false,
			});
		});

		it('marks direct MediaRecorder formats on a desktop profile', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn(
					(type: string) =>
						type === 'audio/webm' || type === 'audio/ogg',
				),
			};
			(global as Record<string, unknown>).AudioContext = jest.fn();

			const byFormat = new Map(
				(await listFormatAvailability()).map((entry) => [
					entry.format,
					entry,
				]),
			);
			expect(byFormat.get('webm')).toMatchObject({
				available: true,
				direct: true,
			});
			expect(byFormat.get('wav')).toMatchObject({
				available: true,
				direct: false,
			});
			delete (global as Record<string, unknown>).AudioContext;
		});
	});
});
