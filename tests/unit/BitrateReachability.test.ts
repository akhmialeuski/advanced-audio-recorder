/**
 * The bitrate offer measured against a real encoder, end to end.
 *
 * Every other suite around the bitrate row stubs the availability probe, which
 * is how a probe that asked the encoder the wrong question shipped green: it
 * left mediabunny to default the channel count to two while a downmixed
 * recording encodes with one, and a Windows install then refused 24 kbps for
 * MP4 only after the recording had been made. Here the detector and the
 * encoder wrapper are both real and only the browser's own
 * `AudioEncoder.isConfigSupported`, reached through mediabunny's
 * `canEncodeAudio`, is scripted.
 * @module tests/unit/BitrateReachability.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { canEncodeAudio } from 'mediabunny';
import { installWindowsAacEncoder } from '../helpers/encoderProfiles';
import { FORMAT_FLAC, FORMAT_M4A, FORMAT_WEBM } from 'src/constants';
import {
	closestBitrate,
	getSupportedBitrates,
	resolveBitrateOffer,
	resolveEffectiveBitrate,
	resolveEffectiveOutputFormat,
	validateRecordingCapability,
	type RecordingEncoding,
} from 'src/audio/AudioCapabilityDetector';

/**
 * The bitrates a Windows Media Foundation AAC encoder accepts. It takes these
 * four and nothing else, which is why a 24 kbps MP4 recording on that platform
 * fails while 96 kbps succeeds.
 */
const MEDIA_FOUNDATION_AAC_BITRATES = [96000, 128000, 160000, 192000];

/** One channel, the layout a downmixed speech recording writes. */
const MONO = 1;

/** Two channels, the layout mediabunny assumes when nobody states one. */
const STEREO = 2;

/**
 * Scripts mediabunny's encoder question the way a platform AAC encoder answers
 * it: a fixed set of rates, and optionally a channel layout it will not encode
 * at all.
 * @param accepted - Bitrates the encoder takes, in bps
 * @param refusedLayouts - Channel counts the encoder refuses outright
 */
function encoderAccepting(
	accepted: readonly number[],
	refusedLayouts: readonly number[] = [],
): void {
	jest.mocked(canEncodeAudio).mockImplementation(
		(
			_codec: unknown,
			options?: {
				numberOfChannels?: number;
				quality?: { options?: { bitrate?: number } };
			},
		): Promise<boolean> => {
			const channels = options?.numberOfChannels ?? STEREO;
			if (refusedLayouts.includes(channels)) {
				return Promise.resolve(false);
			}
			const bitrate = options?.quality?.options?.bitrate;
			return Promise.resolve(
				bitrate === undefined || accepted.includes(bitrate),
			);
		},
	);
}

describe('which bitrates a recording can really use', () => {
	beforeEach(() => {
		// The encoder probe needs the global to exist before it will ask
		// anything; without it the detector reports that it cannot answer.
		(global as Record<string, unknown>).AudioEncoder = jest.fn();
	});

	afterEach(() => {
		delete (global as Record<string, unknown>).AudioEncoder;
	});

	describe('the list a row is given', () => {
		it('offers only what the platform encoder accepts', async () => {
			encoderAccepting(MEDIA_FOUNDATION_AAC_BITRATES);

			const offer = await resolveBitrateOffer(FORMAT_M4A, 48000, MONO);

			expect(offer.bitrates).toEqual(MEDIA_FOUNDATION_AAC_BITRATES);
			expect(offer.encoder).toBe('confirmed');
		});

		it('asks about the layout the recording will have', async () => {
			// The report from the field: the encoder was asked about two
			// channels and answered yes, the recording was mono, and the
			// failure surfaced as "mp4a.40.2, 24000 bps, 1 channels, 48000 Hz
			// is not supported" while the finished audio was being encoded.
			encoderAccepting([24000], [MONO]);

			const stereo = await resolveBitrateOffer(FORMAT_M4A, 48000, STEREO);
			const mono = await resolveBitrateOffer(FORMAT_M4A, 48000, MONO);

			expect(stereo.bitrates).toEqual([24000]);
			expect(mono.encoder).toBe('refused');
		});

		// An encoder that takes nothing anywhere and one that takes plenty at
		// another rate are the same answer here, and that is the point: an
		// offer holds for the rate it was asked about and for no other. The
		// report from the field, third round, is the second row - 22.05 kHz in
		// the settings, where Chromium is asked about HE-AAC and refuses the
		// lot. Answering it with what a 48 kHz encode would take made one
		// offer mean two things: the row narrowed its list to rates measured
		// elsewhere while the recording path refused to move a session onto
		// them. What keeps 22.05 kHz away from the encoder now is that no
		// caller asks at it - every one asks at the rate an offline encode
		// runs at, which this machine's own AudioContext settles.
		it.each([
			[
				'no encoder for the codec at all',
				(): void => encoderAccepting([]),
			],
			[
				'an encoder that takes only rates this one is not',
				(): void => installWindowsAacEncoder(),
			],
		])(
			'reports a refusal at the asked rate as the format being unwritable: %s',
			async (_case, installEncoder) => {
				installEncoder();

				const offer = await resolveBitrateOffer(
					FORMAT_M4A,
					22050,
					MONO,
				);

				expect(offer.bitrates).toEqual(
					getSupportedBitrates(FORMAT_M4A, 22050),
				);
				expect(offer.encoder).toBe('refused');
			},
		);

		it('keeps the codec range where there is no encoder to ask', async () => {
			delete (global as Record<string, unknown>).AudioEncoder;
			encoderAccepting([]);

			const offer = await resolveBitrateOffer(FORMAT_M4A, 48000, MONO);

			expect(offer.encoder).toBe('unavailable');
			expect(jest.mocked(canEncodeAudio)).not.toHaveBeenCalled();
		});

		it('keeps the codec range when the probe itself fails', async () => {
			// A probe that throws is caught where it is made and comes back as
			// "unavailable" per rate, which reaches the row as a refusal: the
			// encoder was there and accepted nothing.
			jest.mocked(canEncodeAudio).mockRejectedValue(
				new Error('probe failed'),
			);

			const offer = await resolveBitrateOffer(FORMAT_M4A, 48000, MONO);

			expect(offer.bitrates).toEqual(
				getSupportedBitrates(FORMAT_M4A, 48000),
			);
			expect(offer.encoder).toBe('refused');
		});

		it('offers the whole Opus range, which has no platform limit', async () => {
			encoderAccepting(getSupportedBitrates(FORMAT_WEBM, 48000));

			const offer = await resolveBitrateOffer(FORMAT_WEBM, 48000, MONO);

			expect(offer.bitrates).toEqual(
				getSupportedBitrates(FORMAT_WEBM, 48000),
			);
			expect(offer.encoder).toBe('confirmed');
		});
	});

	describe('the bitrate a recording starts with', () => {
		/**
		 * A session mediabunny encodes: its tracks are mixed into one file,
		 * so the WebCodecs encoder writes it whatever MediaRecorder could
		 * have captured directly.
		 * @param overrides - What this session differs in
		 * @returns The encoding to resolve against
		 */
		function mergedSession(
			overrides: Partial<RecordingEncoding> = {},
		): RecordingEncoding {
			return {
				sampleRate: 48000,
				numberOfChannels: MONO,
				mergesTracks: true,
				...overrides,
			};
		}

		it('substitutes a rate the encoder refuses', async () => {
			encoderAccepting(MEDIA_FOUNDATION_AAC_BITRATES);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				24000,
				mergedSession(),
			);

			expect(resolved.bitrate).toBe(96000);
			expect(resolved.fellBack).toBe(true);
			expect(resolved.reason).toContain('24 kbps');
		});

		it('names the rate the way every other sentence about it does', async () => {
			// Two notices can be raised by one startRecording, and rounding
			// the rate in this one had a 22.05 kHz setting appear as both
			// 22.05 and 22 kHz in the same session.
			encoderAccepting(MEDIA_FOUNDATION_AAC_BITRATES);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				24000,
				mergedSession({ sampleRate: 22050 }),
			);

			expect(resolved.reason).toContain('at 22.05 kHz');
		});

		it('keeps a rate the encoder takes and reports no substitution', async () => {
			encoderAccepting(MEDIA_FOUNDATION_AAC_BITRATES);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				128000,
				mergedSession(),
			);

			expect(resolved.bitrate).toBe(128000);
			expect(resolved.fellBack).toBe(false);
		});

		it('keeps the configured rate when the encoder accepts none', async () => {
			// Nothing better is on offer, so substituting would trade one
			// refused rate for another. The format row is what reports a
			// format this device cannot produce at all.
			encoderAccepting([]);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				24000,
				mergedSession(),
			);

			expect(resolved.bitrate).toBe(24000);
			expect(resolved.fellBack).toBe(false);
		});

		it('leaves a file MediaRecorder writes itself at the rate it was given', async () => {
			// A single-track M4A on Windows is captured straight into the
			// container by MediaRecorder, which encodes it with its own
			// codec; mediabunny never sees it. Substituting on the WebCodecs
			// answer moved such a recording off a rate it could have used and
			// blamed an encoder that was never going to run.
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: (mime: string): boolean =>
					mime.startsWith('audio/mp4'),
			};
			encoderAccepting(MEDIA_FOUNDATION_AAC_BITRATES);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				24000,
				mergedSession({ mergesTracks: false }),
			);

			expect(resolved.bitrate).toBe(24000);
			expect(resolved.fellBack).toBe(false);
			expect(canEncodeAudio).not.toHaveBeenCalled();
		});

		it('asks nothing about a format that carries no bitrate', async () => {
			// FLAC compresses to whatever size the signal needs and ignores a
			// requested rate, so there is no value for an encoder to refuse
			// and nothing to substitute.
			encoderAccepting([]);

			const resolved = await resolveEffectiveBitrate(
				FORMAT_FLAC,
				24000,
				mergedSession(),
			);

			expect(resolved.bitrate).toBe(24000);
			expect(canEncodeAudio).not.toHaveBeenCalled();
		});

		it('does not blame the bitrate for a format the encoder refuses outright', async () => {
			// Chromium refuses every AAC rate at 22.05 kHz, where mediabunny
			// asks it about HE-AAC, and the offer then answers at the
			// reference rate instead. Reading that as a narrowed list made the
			// notice name a bitrate, while what has to change is the format.
			installWindowsAacEncoder();

			const resolved = await resolveEffectiveBitrate(
				FORMAT_M4A,
				24000,
				mergedSession({ sampleRate: 22050 }),
			);

			expect(resolved.fellBack).toBe(false);
			expect(resolved.reason).toBe('');
		});
	});

	describe('the format a recording starts in', () => {
		/**
		 * Scripts a Chromium that encodes AAC-LC and nothing else: the
		 * question mediabunny asks at 24 kHz and below is about HE-AAC, and
		 * the answer is no whatever the bitrate.
		 */
		function aacLcOnlyEncoder(): void {
			jest.mocked(canEncodeAudio).mockImplementation(
				(codec: unknown, options?: { sampleRate?: number }) =>
					Promise.resolve(
						codec !== 'aac' ||
							(options?.sampleRate ?? 48000) > 24000,
					),
			);
		}

		/**
		 * A MediaRecorder that records MP4 and WebM directly, which is what
		 * the format check used to take as the whole answer.
		 */
		function recorderTaking(...mimeTypes: string[]): void {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: (mime: string): boolean =>
					mimeTypes.some((known) => mime.startsWith(known)),
			};
		}

		afterEach(() => {
			delete (global as Record<string, unknown>).MediaRecorder;
		});

		it('rules MP4 out at 22.05 kHz for a session that mixes its tracks', async () => {
			// The report from the field: two tracks mixed into one MP4 at
			// 22.05 kHz. MediaRecorder records MP4 directly, so the codec
			// check passed, but a merged file is rendered and then encoded by
			// mediabunny, which asked Chromium for HE-AAC and was refused
			// once the recording was already over.
			aacLcOnlyEncoder();
			recorderTaking('audio/mp4', 'audio/webm');

			const result = await validateRecordingCapability(FORMAT_M4A, {
				sampleRate: 22050,
				numberOfChannels: MONO,
				mergesTracks: true,
			});

			expect(result.valid).toBe(false);
			expect(result.reason).toContain('22.05 kHz');
		});

		it('still takes the direct recorder at its word for a single track', async () => {
			// One track recorded straight into MP4 never meets mediabunny, so
			// the encoder has nothing to say about it.
			aacLcOnlyEncoder();
			recorderTaking('audio/mp4', 'audio/webm');

			const result = await validateRecordingCapability(FORMAT_M4A, {
				sampleRate: 22050,
				numberOfChannels: MONO,
				mergesTracks: false,
			});

			expect(result.valid).toBe(true);
		});

		it('falls back to a format the encoder writes at this rate', async () => {
			aacLcOnlyEncoder();
			recorderTaking('audio/mp4', 'audio/webm');

			const resolved = await resolveEffectiveOutputFormat(FORMAT_M4A, {
				sampleRate: 22050,
				numberOfChannels: MONO,
				mergesTracks: true,
			});

			expect(resolved.fellBack).toBe(true);
			expect(resolved.format).toBe(FORMAT_WEBM);
			expect(resolved.reason).toContain('22.05 kHz');
		});
	});

	it('answers with the rate asked for when nothing is offered at all', () => {
		// A format whose floor rose above every candidate would leave the list
		// empty, and a caller must not have to test that before asking.
		expect(closestBitrate([], 111000)).toBe(111000);
	});
});
