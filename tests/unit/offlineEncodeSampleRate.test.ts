/**
 * The device sample rate is read from one AudioContext, not one per question.
 *
 * The settings tab asks for the rate several times per render and again after
 * every save. Chromium caps the number of live hardware contexts and frees a
 * slot only when the asynchronous close completes, so a context per call is a
 * burst of renders away from a refused constructor. The reading is a property
 * of the device, so one context answers for all of them.
 * @module tests/unit/offlineEncodeSampleRate.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { offlineEncodeSampleRate } from 'src/audio/AudioFormatConverter';
import {
	installAudioContextRate,
	type AudioContextDouble,
	type InstalledMock,
} from '../helpers/mediaMocks';

/** The rate the settings ask for, which the device does not run at. */
const REQUESTED_RATE = 22050;

/** The rate the stubbed device runs at. */
const DEVICE_RATE = 48000;

describe('the rate an offline encode runs at', () => {
	/** The device a case is running on, restored after it. */
	let device: InstalledMock<AudioContextDouble> | null = null;

	afterEach(() => {
		device?.restore();
		device = null;
	});

	it('answers with the requested rate where there is no AudioContext', () => {
		expect(offlineEncodeSampleRate(REQUESTED_RATE)).toBe(REQUESTED_RATE);
	});

	it('opens one context for every question asked of the same device', () => {
		device = installAudioContextRate(DEVICE_RATE);

		const first = offlineEncodeSampleRate(REQUESTED_RATE);
		const second = offlineEncodeSampleRate(REQUESTED_RATE);

		expect([first, second]).toEqual([DEVICE_RATE, DEVICE_RATE]);
		expect(device.instances).toHaveLength(1);
	});

	it('reads another implementation afresh rather than repeating the last answer', () => {
		installAudioContextRate(DEVICE_RATE);
		offlineEncodeSampleRate(REQUESTED_RATE);
		device = installAudioContextRate(REQUESTED_RATE);

		expect(offlineEncodeSampleRate(REQUESTED_RATE)).toBe(REQUESTED_RATE);
		expect(device.instances).toHaveLength(1);
	});

	it('reports a close that fails instead of leaving it unhandled', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const failure = new Error('device busy');
		device = installAudioContextRate(DEVICE_RATE, () =>
			Promise.reject(failure),
		);

		expect(offlineEncodeSampleRate(REQUESTED_RATE)).toBe(DEVICE_RATE);
		// The rejection is delivered on a later microtask; the handler must
		// already be attached by then.
		await Promise.resolve();
		await Promise.resolve();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to close the AudioContext'),
			failure,
		);
	});
});
