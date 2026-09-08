/**
 * Unit tests for the capture-session snapshot.
 *
 * The session is the one point every recorder, merge and conversion of a run
 * reads its bitrate from, which is why the format's floor is applied here
 * rather than at each of them.
 * @module tests/unit/CaptureSession.test
 */

// The registry builds mediabunny container writers at module scope; the
// shared double carries them.
jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

jest.mock('src/audio/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
	probeOfflineEncodingSupport: jest.fn().mockResolvedValue(true),
}));

import { createCaptureSession } from 'src/recording/CaptureSession';
import type { CaptureSessionRequest } from 'src/recording/CaptureSession';
import { DEFAULT_BITRATE, FORMAT_MP3, FORMAT_WEBM } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { useDesktopPlatform } from '../helpers/platform';

/**
 * A single-track session request over the default settings.
 * @param overrides - The settings and formats under test
 * @returns The request createCaptureSession is called with
 */
function requestWith(overrides: {
	bitrate: number;
	sampleRate?: number;
	outputFormat: string;
	recorderFormat?: string;
	resolvedBitrate?: number;
}): CaptureSessionRequest {
	return {
		settings: {
			...DEFAULT_SETTINGS,
			bitrate: overrides.bitrate,
			sampleRate: overrides.sampleRate ?? 44100,
		},
		streamCount: 1,
		trackOrder: [],
		outputFormat: overrides.outputFormat,
		recorderFormat: overrides.recorderFormat ?? overrides.outputFormat,
		isWavPcm: false,
		...(overrides.resolvedBitrate === undefined
			? {}
			: { bitrate: overrides.resolvedBitrate }),
	};
}

describe('createCaptureSession', () => {
	beforeEach(() => {
		useDesktopPlatform();
	});

	it('keeps a bitrate the output format can write', () => {
		const { session } = createCaptureSession(
			requestWith({ bitrate: 24000, outputFormat: FORMAT_WEBM }),
		);

		expect(session.bitrate).toBe(24000);
	});

	it('takes the rate the caller already resolved against the encoder', () => {
		// Only the platform encoder knows which rates it accepts, and asking
		// it is asynchronous, so the manager resolves the rate before the
		// session is built. A session that re-derived it from the settings
		// would put back the value the encoder had just refused, and the
		// recording would fail while it was being saved.
		const { session } = createCaptureSession(
			requestWith({
				bitrate: 24000,
				outputFormat: FORMAT_WEBM,
				resolvedBitrate: 96000,
			}),
		);

		expect(session.bitrate).toBe(96000);
	});

	it('lifts a bitrate the output format has no table for', () => {
		// MP3 at 44.1 kHz is MPEG-1 Layer III, which starts at 32 kbps. LAME
		// would lift the value itself and say nothing, leaving every surface
		// announcing a bitrate the file does not carry.
		const { session } = createCaptureSession(
			requestWith({ bitrate: 24000, outputFormat: FORMAT_MP3 }),
		);

		expect(session.bitrate).toBe(32000);
	});

	it('keeps it where the sample rate reaches the lower MPEG tables', () => {
		const { session } = createCaptureSession(
			requestWith({
				bitrate: 24000,
				sampleRate: 22050,
				outputFormat: FORMAT_MP3,
			}),
		);

		expect(session.bitrate).toBe(24000);
	});

	it('takes the floor from the output format, not the recorder container', () => {
		// An offline-only target records through an intermediate whose own
		// floor is lower, and the file that survives the run is the target's.
		const { session } = createCaptureSession(
			requestWith({
				bitrate: 24000,
				outputFormat: FORMAT_MP3,
				recorderFormat: FORMAT_WEBM,
			}),
		);

		expect(session.bitrate).toBe(32000);
	});

	it('falls back to the default for a bitrate a corrupt file left behind', () => {
		const { session } = createCaptureSession(
			requestWith({ bitrate: 0, outputFormat: FORMAT_WEBM }),
		);

		expect(session.bitrate).toBe(DEFAULT_BITRATE);
	});
});
