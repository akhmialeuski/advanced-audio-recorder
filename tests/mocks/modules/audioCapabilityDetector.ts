/**
 * Default double for `src/audio/AudioCapabilityDetector`, as the suites that
 * render a bitrate row need it.
 *
 * Which rates a format reaches is the format registry's business and is pinned
 * in its own suite, and which of them a device accepts needs an encoder jsdom
 * does not ship, so both are stubs a test can script. Snapping is not: a row's
 * whole contract is which value it settles on, so the double runs the real
 * rule over whatever list the test installed, and a suite that changes the
 * offered rates gets the matching selection for free.
 *
 * Usage:
 * ```ts
 * jest.mock('src/audio/AudioCapabilityDetector', () =>
 *     require('../mocks/modules/audioCapabilityDetector'),
 * );
 * ```
 * @module tests/mocks/modules/audioCapabilityDetector
 */

/** Availability of one candidate bitrate, mirroring the real entry shape. */
export interface BitrateAvailabilityEntry {
	bitrate: number;
	available: boolean;
}

/** Bitrates the double offers until a suite installs its own list. */
export const DOUBLE_BITRATES = [64000, 96000, 128000, 192000, 256000, 320000];

/** Sample rates the double offers. */
export const DOUBLE_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000];

export const getSupportedBitrates = jest.fn(
	(_format?: string, _sampleRate?: number): number[] => [...DOUBLE_BITRATES],
);

export const getSupportedSampleRates = jest.fn((): number[] => [
	...DOUBLE_SAMPLE_RATES,
]);

export const listBitrateAvailability = jest.fn(
	(): Promise<BitrateAvailabilityEntry[]> => Promise.resolve([]),
);

/**
 * What the encoder question resolves to. The default answers with the list the
 * double is offering, unconfirmed, which is what a suite that is not about the
 * encoder wants: the row shows the codec's own range and nothing narrows it.
 */
export const resolveBitrateOffer = jest.fn(
	(
		format: string,
		sampleRate?: number,
	): Promise<{
		bitrates: number[];
		encoder: 'confirmed' | 'unavailable' | 'refused';
		sampleRate: number;
	}> =>
		Promise.resolve({
			bitrates: getSupportedBitrates(format, sampleRate),
			encoder: 'unavailable',
			sampleRate: sampleRate ?? 44100,
		}),
);

/**
 * The real snapping rule, which the row and the session both depend on.
 * @param offered - Candidate bitrates in ascending order, at least one
 * @param requested - The bitrate asked for
 * @returns The closest candidate, ties going to the higher one
 */
export const closestBitrate = (
	offered: readonly number[],
	requested: number,
): number =>
	offered.reduce((closest, bps) =>
		Math.abs(bps - requested) <= Math.abs(closest - requested)
			? bps
			: closest,
	);

/**
 * Snaps onto the list the double is currently offering, so a suite that
 * narrows that list narrows what a row can settle on with it.
 * @param format - Target audio format
 * @param bitrate - The bitrate asked for
 * @param sampleRate - Rate the encoder would write at
 * @returns The bitrate the row settles on
 */
export const effectiveBitrate = jest.fn(
	(format: string, bitrate: number, sampleRate?: number): number => {
		const offered = getSupportedBitrates(format, sampleRate);
		return offered.length > 0 ? closestBitrate(offered, bitrate) : bitrate;
	},
);
