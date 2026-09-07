/**
 * Unit tests for the audio format registry.
 *
 * The bitrate floor each descriptor declares is what the settings row, the
 * conversion dialog and the split dialog all cut their lists to, and nothing
 * downstream refuses a value below it: LAME lifts a rate its table lacks to
 * the nearest one it has, silently, so a wrong floor reaches a file rather
 * than an error. Mediabunny's own `canEncodeAudio` cannot stand in for this
 * check, because the bundled MP3 and FLAC encoders report support without
 * reading the bitrate at all and the WebCodecs path needs a browser, so the
 * declared floors are pinned against the MPEG tables instead.
 * @module tests/unit/formatRegistry.test
 */

// The registry builds mediabunny container writers at module scope; the
// shared double carries them.
jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

// Offline encoding is probed by the capability detector, which is only
// imported here for the sample rates the plugin offers.
jest.mock('src/audio/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
	probeOfflineEncodingSupport: jest.fn().mockResolvedValue(true),
}));

import {
	FORMAT_AAC,
	FORMAT_FLAC,
	FORMAT_M4A,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_OGG,
	FORMAT_WAV,
	FORMAT_WEBM,
} from 'src/constants';
import { getSupportedSampleRates } from 'src/audio/AudioCapabilityDetector';
import { getFormatDescriptor } from 'src/audio/formatRegistry';
import { defined } from '../helpers/assertions';

/** Bitrates ISO/IEC 11172-3 Layer III defines, in kbps. */
const MPEG1_LAYER3_KBPS = [
	32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];

/** Bitrates ISO/IEC 13818-3 Layer III defines, in kbps. */
const MPEG2_LAYER3_KBPS = [
	8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];

/**
 * The MPEG table MP3 encodes with at each sample rate the plugin offers. The
 * bundled LAME bridge pins the output rate to the input rate, so the rate the
 * user picks decides the table and the encoder cannot move to another one.
 */
const MP3_TABLE_BY_SAMPLE_RATE: [number, number[]][] = [
	[8000, MPEG2_LAYER3_KBPS],
	[16000, MPEG2_LAYER3_KBPS],
	[22050, MPEG2_LAYER3_KBPS],
	[44100, MPEG1_LAYER3_KBPS],
	[48000, MPEG1_LAYER3_KBPS],
];

/**
 * The floor a format declares at one sample rate.
 * @param format - Registry format id
 * @param sampleRate - Rate the encoder would write at
 * @returns The declared floor in bps
 */
function floorOf(format: string, sampleRate: number): number {
	return defined(getFormatDescriptor(format)).minBitrate(sampleRate);
}

describe('format registry', () => {
	describe('the bitrate floor a format declares', () => {
		it('is pinned at every sample rate the plugin offers', () => {
			// A new capture rate with no table beside it would otherwise be
			// checked by nothing at all.
			expect(MP3_TABLE_BY_SAMPLE_RATE.map(([rate]) => rate)).toEqual(
				getSupportedSampleRates(),
			);
		});

		it.each(MP3_TABLE_BY_SAMPLE_RATE)(
			'matches the MPEG table MP3 writes with at %i Hz',
			(sampleRate, table) => {
				expect(floorOf(FORMAT_MP3, sampleRate)).toBe(
					Math.min(...table) * 1000,
				);
			},
		);

		it.each([FORMAT_WEBM, FORMAT_OGG])(
			'is the Opus floor for %s at every rate',
			(format) => {
				// RFC 6716 section 2.1.1: Opus encodes from 6 kbit/s upward,
				// at every sample rate it accepts.
				for (const sampleRate of getSupportedSampleRates()) {
					expect(floorOf(format, sampleRate)).toBe(6000);
				}
			},
		);

		it.each([FORMAT_M4A, FORMAT_MP4, FORMAT_AAC])(
			'is absent for %s, whose limit the platform encoder settles',
			(format) => {
				// WebCodecs hands AAC to the operating system, so a number
				// declared here would be a guess about somebody else's
				// encoder. The bitrate row probes for it instead.
				expect(floorOf(format, 44100)).toBe(0);
			},
		);

		it.each([FORMAT_WAV, FORMAT_FLAC])(
			'is absent for %s, which carries no bitrate',
			(format) => {
				// WAV is uncompressed and the FLAC encoder discards the
				// bitrate it is handed, so neither has a rate to be below.
				expect(floorOf(format, 44100)).toBe(0);
			},
		);
	});
});
