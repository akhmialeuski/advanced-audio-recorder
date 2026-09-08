/**
 * Every format against every way a recording can be made, on one device
 * profile, in one table.
 *
 * The bitrate and format rows were fixed one screenshot at a time, and each
 * fix left another cell wrong: MP4 blocked at a rate the mix never uses, a
 * bitrate offered for FLAC, a check that passed a merged session the encoder
 * then refused. This suite is the whole grid at once. The device is a Windows
 * desktop as the field reports describe it: MediaRecorder records WebM, OGG
 * and MP4; the platform AAC encoder takes 96 to 192 kbps and only AAC-LC, so
 * nothing at 24 kHz or below; the bundled MP3 and FLAC encoders accept
 * everything; the AudioContext runs at 48 kHz whatever the settings ask.
 * @module tests/integration/FormatBitrateMatrix.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

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
import {
	getSupportedBitrates,
	resolveBitrateOffer,
	validateRecordingCapability,
	type EncoderVerdict,
} from 'src/audio/AudioCapabilityDetector';
import { AUDIO_FORMAT_IDS } from 'src/audio/formatRegistry';
import { bitrateOfferNote, takesBitrate } from 'src/settings/settingControls';
import { recordingEncodingFor } from 'src/recording/AudioStreamHandler';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { useDesktopPlatform } from '../helpers/platform';
import {
	WINDOWS_AAC_BITRATES,
	installWindowsAacEncoder,
} from '../helpers/encoderProfiles';

/** The rate the device's AudioContext runs at, whatever was requested. */
const DEVICE_RATE = 48000;

/**
 * Installs the device profile: MediaRecorder, the encoder answer and the
 * AudioContext rate. The encoder is asked by codec, so the answer is written
 * per codec rather than per format.
 */
function installWindowsDesktop(): void {
	(global as Record<string, unknown>).MediaRecorder = {
		isTypeSupported: (mime: string): boolean =>
			['audio/webm', 'audio/ogg', 'audio/mp4'].some((known) =>
				mime.startsWith(known),
			),
	};
	(global as Record<string, unknown>).AudioEncoder = jest.fn();
	(global as Record<string, unknown>).AudioContext = jest.fn(() => ({
		sampleRate: DEVICE_RATE,
		close: (): Promise<void> => Promise.resolve(),
	}));
	installWindowsAacEncoder(DEVICE_RATE);
}

describe('every format on a Windows desktop', () => {
	beforeEach(() => {
		useDesktopPlatform();
		installWindowsDesktop();
	});

	afterEach(() => {
		for (const name of ['MediaRecorder', 'AudioEncoder', 'AudioContext']) {
			delete (global as Record<string, unknown>)[name];
		}
	});

	it('covers the whole registry, so a new format has to take a row here', () => {
		expect([...AUDIO_FORMAT_IDS].sort()).toEqual(
			[...MATRIX.map((row) => row.format)].sort(),
		);
	});

	/**
	 * One row per format: whether a bitrate can be chosen, what the codec's
	 * own floor is at the two rates that matter, what the encoder says at the
	 * device rate, and whether a single-track and a merged session may start
	 * in it at the device rate and at 22.05 kHz.
	 */
	/** What every AAC container shares; the format and the direct path differ. */
	const AAC_ROW = {
		takesBitrate: true,
		floorAt48k: 0,
		floorAt22k: 0,
		offered: WINDOWS_AAC_BITRATES,
		verdict: 'confirmed' as const,
		singleAt48k: true,
		mergedAt48k: true,
		mergedAt22k: false,
	};

	const MATRIX: readonly {
		format: string;
		takesBitrate: boolean;
		floorAt48k: number;
		floorAt22k: number;
		offered: number[] | 'all';
		verdict: EncoderVerdict;
		singleAt48k: boolean;
		mergedAt48k: boolean;
		singleAt22k: boolean;
		mergedAt22k: boolean;
	}[] = [
		{
			format: FORMAT_WAV,
			takesBitrate: false,
			floorAt48k: 0,
			floorAt22k: 0,
			offered: 'all',
			verdict: 'confirmed',
			singleAt48k: true,
			mergedAt48k: true,
			singleAt22k: true,
			mergedAt22k: true,
		},
		{
			format: FORMAT_WEBM,
			takesBitrate: true,
			floorAt48k: 6000,
			floorAt22k: 6000,
			offered: 'all',
			verdict: 'confirmed',
			singleAt48k: true,
			mergedAt48k: true,
			singleAt22k: true,
			mergedAt22k: true,
		},
		{
			format: FORMAT_OGG,
			takesBitrate: true,
			floorAt48k: 6000,
			floorAt22k: 6000,
			offered: 'all',
			verdict: 'confirmed',
			singleAt48k: true,
			mergedAt48k: true,
			singleAt22k: true,
			mergedAt22k: true,
		},
		{
			format: FORMAT_MP3,
			takesBitrate: true,
			floorAt48k: 32000,
			floorAt22k: 8000,
			offered: 'all',
			verdict: 'confirmed',
			singleAt48k: true,
			mergedAt48k: true,
			singleAt22k: true,
			mergedAt22k: true,
		},
		// Recorded straight into the container by MediaRecorder for a single
		// track, which never asks the WebCodecs encoder, so the rate does not
		// matter there; mixed and then encoded by mediabunny for a merged
		// session, which asks for HE-AAC at 22.05 kHz.
		...[FORMAT_M4A, FORMAT_MP4].map((format) => ({
			...AAC_ROW,
			format,
			singleAt22k: true,
		})),
		{
			format: FORMAT_FLAC,
			takesBitrate: false,
			floorAt48k: 0,
			floorAt22k: 0,
			offered: 'all',
			verdict: 'confirmed',
			singleAt48k: true,
			mergedAt48k: true,
			singleAt22k: true,
			mergedAt22k: true,
		},
		// Offline-only: encoded by mediabunny in every session shape.
		{ ...AAC_ROW, format: FORMAT_AAC, singleAt22k: false },
	];

	describe.each(MATRIX)('$format', (row) => {
		it(`${row.takesBitrate ? 'offers' : 'does not offer'} a bitrate`, () => {
			expect(takesBitrate(row.format)).toBe(row.takesBitrate);
		});

		it('starts its bitrate list where the codec does', () => {
			expect(getSupportedBitrates(row.format, DEVICE_RATE)[0]).toBe(
				Math.max(row.floorAt48k, 24000),
			);
			expect(getSupportedBitrates(row.format, 22050)[0]).toBe(
				Math.max(row.floorAt22k, 24000),
			);
		});

		it('offers what the encoder accepts at the device rate', async () => {
			const offer = await resolveBitrateOffer(row.format, DEVICE_RATE, 1);

			expect(offer.encoder).toBe(row.verdict);
			expect(offer.bitrates).toEqual(
				row.offered === 'all'
					? getSupportedBitrates(row.format, DEVICE_RATE)
					: row.offered,
			);
		});

		it('explains the list in the row', async () => {
			const offer = await resolveBitrateOffer(row.format, DEVICE_RATE, 1);

			const note = bitrateOfferNote(row.format, DEVICE_RATE, offer);
			expect(note).toContain('at 48 kHz reaches');
			expect(note).toContain(
				row.offered === 'all'
					? 'accepts all of them'
					: 'accepts only the values listed',
			);
		});

		it.each([
			[
				'a single track at the device rate',
				DEVICE_RATE,
				false,
				row.singleAt48k,
			],
			[
				'a merged session at the device rate',
				DEVICE_RATE,
				true,
				row.mergedAt48k,
			],
			['a single track at 22.05 kHz', 22050, false, row.singleAt22k],
			['a merged session at 22.05 kHz', 22050, true, row.mergedAt22k],
		])('%s', async (_case, sampleRate, mergesTracks, expected) => {
			const result = await validateRecordingCapability(row.format, {
				sampleRate,
				numberOfChannels: 1,
				mergesTracks,
			});

			// A refusal names the rate it was asked about, so a session that
			// is refused at 22.05 kHz is told why; a valid result has no reason.
			expect({
				valid: result.valid,
				namesRate: result.reason.includes('22.05 kHz'),
			}).toEqual({ valid: expected, namesRate: !expected });
		});
	});

	describe.each([FORMAT_M4A, FORMAT_MP4, FORMAT_AAC])(
		'%s with 22.05 kHz in the settings',
		(format) => {
			it('still offers only what the AAC encoder accepts, so 24 kbps cannot be picked', async () => {
				// The field report: 24 kbps chosen for M4A, capture came out
				// at 96. Asked at 22.05 kHz the encoder refuses everything,
				// and the row used to read that as nothing to narrow by.
				const offer = await resolveBitrateOffer(format, 22050, 1);

				expect(offer.bitrates).toEqual(WINDOWS_AAC_BITRATES);
				expect(offer.encoder).toBe('confirmed');
				expect(bitrateOfferNote(format, 22050, offer)).toContain(
					'AAC at 48 kHz reaches 96-192 kbps. The encoder on this device accepts only the values listed. For the lower rates use WebM or OGG',
				);
			});
		},
	);

	it('asks every question at the rate the device encodes at, not the one requested', () => {
		// The rows above are asked at the device rate because that is what
		// the settings hand them: a mix and a re-encode both run through an
		// AudioContext at its own rate, so 22.05 kHz in the settings is a
		// 48 kHz file on this machine.
		const encoding = recordingEncodingFor({
			...DEFAULT_SETTINGS,
			sampleRate: 22050,
		});

		expect(encoding.sampleRate).toBe(DEVICE_RATE);
	});
});
