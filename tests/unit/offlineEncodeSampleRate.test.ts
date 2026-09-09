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

	/** Whether a case installed a refusing constructor of its own. */
	let refusing = false;

	/**
	 * Installs a device that refuses another context, which is what Chromium
	 * does once a document holds its maximum of live hardware ones.
	 * @param refusal - What the constructor throws
	 */
	function refuseAudioContext(refusal: Error): void {
		refusing = true;
		(global as Record<string, unknown>)['AudioContext'] = jest.fn(() => {
			throw refusal;
		});
	}

	afterEach(() => {
		device?.restore();
		device = null;
		// Cleared after the handle, which may have restored the refusing
		// constructor as the value it found.
		if (refusing) {
			delete (global as Record<string, unknown>)['AudioContext'];
			refusing = false;
		}
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

	it('answers with the requested rate when the device refuses another context', () => {
		// The cap this reading is memoised against is the same one that
		// refuses the constructor once a document holds its maximum of live
		// hardware contexts. The settings renderer runs a row's callback
		// unguarded, so a throw here took down every setting rather than one
		// row, and a recording failed before its format was resolved.
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const refusal = new Error('too many contexts');
		refuseAudioContext(refusal);

		expect(offlineEncodeSampleRate(REQUESTED_RATE)).toBe(REQUESTED_RATE);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Could not open an AudioContext'),
			refusal,
		);
	});

	it('reads the device again once a context can be opened', () => {
		// The refusal is a passing condition, not an answer about the device,
		// so it must not be remembered: memoising it would leave every later
		// question answered with the rate the settings asked for.
		refuseAudioContext(new Error('too many contexts'));
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		offlineEncodeSampleRate(REQUESTED_RATE);
		device = installAudioContextRate(DEVICE_RATE);

		expect(offlineEncodeSampleRate(REQUESTED_RATE)).toBe(DEVICE_RATE);
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
