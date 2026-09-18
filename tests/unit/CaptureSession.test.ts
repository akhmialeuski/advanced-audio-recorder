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
import type {
	CaptureSession,
	CaptureSessionRequest,
} from 'src/recording/CaptureSession';
import { DEFAULT_BITRATE, FORMAT_MP3, FORMAT_WEBM } from 'src/constants';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { useDesktopPlatform } from '../helpers/platform';
import {
	installAudioContextRate,
	type AudioContextDouble,
	type InstalledMock,
} from '../helpers/mediaMocks';

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

/**
 * One of a session's tracks, named off the request rather than imported from
 * the capture module: a unit test that reaches for five source modules is one
 * the layer check sends to the integration suite.
 */
type SessionTrack = CaptureSessionRequest['trackOrder'][number];

/** A second track recording this machine's own output rather than an input. */
const SYSTEM_AUDIO_TRACK: SessionTrack = {
	trackNumber: 2,
	deviceId: '',
	channelMode: 'source',
	kind: 'system-audio',
};

/**
 * A two-track session over the default settings, as the manager hands one in.
 *
 * Three cases differ only in what makes the session merge and in what its
 * second track records, so the request around them is built once here.
 * @param settings - What this session's settings differ in
 * @param second - The second track, another microphone unless a case says so
 * @returns The frozen snapshot every writer of the run reads
 */
function twoTrackSession(
	settings: Partial<AudioRecorderSettings>,
	second: SessionTrack = {
		trackNumber: 2,
		deviceId: 'mic-2',
		channelMode: 'source',
	},
): CaptureSession {
	const request = requestWith({
		bitrate: DEFAULT_BITRATE,
		outputFormat: FORMAT_WEBM,
	});
	return createCaptureSession({
		...request,
		settings: { ...request.settings, ...settings },
		streamCount: 2,
		trackOrder: [
			{ trackNumber: 1, deviceId: 'mic-1', channelMode: 'source' },
			second,
		],
	}).session;
}

describe('createCaptureSession', () => {
	/** The device this case is running on, restored after it. */
	let device: InstalledMock<AudioContextDouble> | null = null;

	beforeEach(() => {
		device = null;
		useDesktopPlatform();
	});

	afterEach(() => {
		device?.restore();
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

	// One session asking for 24 kbps MP3 at 22.05 kHz, on two devices. It is
	// the device that decides, because an offline encode runs at the rate the
	// hardware provides whatever the settings ask for: the MPEG-2 tables MP3
	// uses below 32 kHz reach 24 kbps, while MPEG-1 has no table under 32.
	// Cut at the requested rate instead, the session carried 24 kbps onto a
	// 48 kHz device and LAME lifted it without a word.
	it.each([
		['reaches the lower MPEG tables', 22050, 24000],
		['is held to the MPEG-1 table', 48000, 32000],
	])(
		'takes the floor at the rate the encoder writes at, which %s',
		(_case, deviceRate, expected) => {
			device = installAudioContextRate(deviceRate);

			const { session } = createCaptureSession(
				requestWith({
					bitrate: 24000,
					sampleRate: 22050,
					outputFormat: FORMAT_MP3,
				}),
			);

			expect(session.bitrate).toBe(expected);
		},
	);

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

	// The stored mode is the multi-track page's, and a session that paired the
	// microphone with the system output configured no tracks there: what it
	// records is one call, so the snapshot every writer reads says one file
	// however that page was last left.
	it('writes a system-audio pairing as one file', () => {
		const session = twoTrackSession(
			{ includeSystemAudio: true, outputMode: 'multiple' },
			SYSTEM_AUDIO_TRACK,
		);

		expect(session.outputMode).toBe('single');
		expect(session.trackMix).toHaveLength(2);
	});

	// Match track levels sits on the multi-track page under a predicate that
	// hides it while multi-track is off, so a pairing can neither show it nor
	// be configured through it. Left applied, a value stored by an earlier
	// multi-track session went on correcting the levels of a recorded call
	// with nothing on screen saying so.
	it('leaves a system-audio pairing at the levels it recorded', () => {
		const session = twoTrackSession(
			{ includeSystemAudio: true, mixAlignTrackLevels: true },
			SYSTEM_AUDIO_TRACK,
		);

		expect(session.alignTrackLevels).toBe(false);
	});

	// The same switch on the session it was written for, so the fix above
	// cannot have turned the feature off for everyone.
	it('levels the tracks of a session that configured them', () => {
		const session = twoTrackSession({
			enableMultiTrack: true,
			mixAlignTrackLevels: true,
		});

		expect(session.alignTrackLevels).toBe(true);
	});
});
