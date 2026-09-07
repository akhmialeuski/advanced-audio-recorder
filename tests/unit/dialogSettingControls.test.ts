/**
 * Unit tests for the shared setting builders.
 * @module tests/unit/dialogSettingControls.test
 */

import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
	type BitrateRow,
} from 'src/settings/settingControls';
import { FORMAT_MP3, FORMAT_WAV, FORMAT_WEBM } from 'src/constants';
import {
	getSupportedBitrates,
	listBitrateAvailability,
	type BitrateAvailabilityEntry,
} from 'src/audio/AudioCapabilityDetector';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { capturedSettings } from '../helpers/captureSettings';
import type { CapturedSetting } from '../helpers/captureSettings';

// The full obsidian mock with only Setting swapped for the recording double.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

// The floors themselves are the format registry's business and are pinned in
// its own suite; here the detector is a stand-in so the builder can be asked
// what it passes on and what it does with the answer.
jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000]),
	listBitrateAvailability: jest.fn().mockResolvedValue([]),
}));

describe('dialog setting builders', () => {
	let containerEl: HTMLElement;

	beforeEach(() => {
		capturedSettings.length = 0;
		containerEl = document.createElement('div');
		// clearMocks keeps whatever a test installed, and these two carry the
		// list every case below starts from.
		jest.mocked(getSupportedBitrates).mockReturnValue([
			64000, 96000, 128000, 192000,
		]);
		jest.mocked(listBitrateAvailability).mockResolvedValue([]);
	});

	/**
	 * The single row these builders render.
	 * @returns The captured row
	 */
	function row(): CapturedSetting {
		return at(capturedSettings, 0);
	}

	/** The bitrates the detector double offers, in the order it offers them. */
	const OFFERED = [64000, 96000, 128000, 192000];

	/**
	 * Scripts the encoder probe's answer for those bitrates.
	 * @param available - Whether each offered bitrate is accepted, in order
	 * @returns The entries the probe will resolve with
	 */
	function probeAnswers(available: boolean[]): BitrateAvailabilityEntry[] {
		const entries = OFFERED.map((bitrate, index) => ({
			bitrate,
			available: available[index] ?? false,
		}));
		jest.mocked(listBitrateAvailability).mockResolvedValue(entries);
		return entries;
	}

	/**
	 * The row every case below is built from, over the detector double's list.
	 * @param format - Target format the row is offered for
	 * @param initialBitrate - The value the row starts from
	 * @param onChange - Where the row reports a settled value
	 * @returns The row under test
	 */
	function bitrateRowFor(
		format: string = FORMAT_WEBM,
		initialBitrate = 128000,
		onChange: (bitrate: number) => void = jest.fn(),
	): BitrateRow {
		return addBitrateSetting(containerEl, {
			desc: 'Bitrate.',
			format,
			initialBitrate,
			onChange,
		});
	}

	describe('addBitrateSetting', () => {
		it('lists supported bitrates with kbps labels', () => {
			bitrateRowFor();

			expect(
				(row().dropdownOptions ?? []).map(({ value, label }) => ({
					value,
					label,
				})),
			).toEqual([
				{ value: '64000', label: '64 kbps' },
				{ value: '96000', label: '96 kbps' },
				{ value: '128000', label: '128 kbps' },
				{ value: '192000', label: '192 kbps' },
			]);
			expect(row().dropdownValue).toBe('128000');
		});

		it('asks for the bitrates the target format reaches', () => {
			// A list built without the target is the defect this row exists to
			// avoid: MP3 at 44.1 kHz reaches nothing under 32 kbps, and a row
			// that offers 24 promises a file the encoder will not write.
			addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				format: FORMAT_MP3,
				sampleRate: 44100,
				initialBitrate: 128000,
				onChange: jest.fn(),
			});

			expect(jest.mocked(getSupportedBitrates)).toHaveBeenCalledWith(
				FORMAT_MP3,
				44100,
			);
		});

		it('snaps an unsupported initial bitrate to the closest entry', () => {
			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 100000);

			expect(bitrateRow.value).toBe(96000);
			expect(row().dropdownValue).toBe('96000');
		});

		it('reports numeric bitrate changes', () => {
			const onChange = jest.fn();
			bitrateRowFor(FORMAT_WEBM, 128000, onChange);

			row().changes.dropdown?.('192000');

			expect(onChange).toHaveBeenCalledWith(192000);
		});

		it('re-offers the list and reports a value the new one moved', () => {
			// What a conversion dialog does when its target changes: the
			// bitrate held for the old target may not exist for the new one,
			// and the caller has to hear about the substitution.
			const onChange = jest.fn();
			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 64000, onChange);
			jest.mocked(getSupportedBitrates).mockReturnValue([128000, 192000]);

			bitrateRow.rebuild(FORMAT_MP3);

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(['128000', '192000']);
			expect(bitrateRow.value).toBe(128000);
			expect(onChange).toHaveBeenCalledWith(128000);
		});

		it('hides itself for a target that takes no bitrate', () => {
			const bitrateRow = bitrateRowFor();
			expect(row().el.style.display).not.toBe('none');

			bitrateRow.rebuild(FORMAT_WAV);

			expect(row().el.style.display).toBe('none');
		});

		it('blocks a bitrate this device cannot encode', async () => {
			probeAnswers([false, true, true, true]);

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).map((option) => option.disabled),
			).toEqual([true, false, false, false]);
		});

		it('blocks nothing when the probe finds nothing available', async () => {
			// What an environment without a WebCodecs AudioEncoder reports for
			// every value. A row with no selectable option is worse than one
			// offering a value the encoder may later decline.
			probeAnswers([false, false, false, false]);

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).every(
					(option) => !option.disabled,
				),
			).toBe(true);
		});

		it('leaves an option the probe said nothing about alone', async () => {
			// The probe answers about the bitrates the format reaches, and a
			// row rebuilt in the meantime can be showing more than those.
			jest.mocked(listBitrateAvailability).mockResolvedValue([
				{ bitrate: 64000, available: false },
				{ bitrate: 96000, available: true },
			]);

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).map((option) => option.disabled),
			).toEqual([true, false, false, false]);
		});

		it('leaves the list alone when the probe itself fails', async () => {
			// A failed probe says nothing about the device, and the encoder
			// still reports a refusal when the run reaches it.
			jest.mocked(listBitrateAvailability).mockRejectedValue(
				new Error('probe failed'),
			);

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).every(
					(option) => !option.disabled,
				),
			).toBe(true);
		});

		it('hides itself for a target outside the registry', () => {
			// A hand-edited extension, or one from a newer version: nothing is
			// known about its codec, so nothing can be promised about a rate.
			const bitrateRow = bitrateRowFor();

			bitrateRow.rebuild('aiff');

			expect(row().el.style.display).toBe('none');
		});

		it('keeps the value asked for when nothing is on offer', () => {
			jest.mocked(getSupportedBitrates).mockReturnValue([]);

			expect(bitrateRowFor(FORMAT_WEBM, 111000).value).toBe(111000);
		});

		it('drops a probe answer overtaken by a later target', async () => {
			// Two targets in flight at once: the answer for the one no longer
			// on screen must not disable options it was never asked about.
			let settleWebm: (
				entries: BitrateAvailabilityEntry[],
			) => void = () => undefined;
			jest.mocked(listBitrateAvailability).mockReturnValueOnce(
				new Promise((resolve) => {
					settleWebm = resolve;
				}),
			);
			const bitrateRow = bitrateRowFor();

			probeAnswers([true, true, true, true]);
			bitrateRow.rebuild(FORMAT_MP3);
			await tick();
			settleWebm([
				{ bitrate: 64000, available: false },
				{ bitrate: 96000, available: false },
			]);
			await tick();

			expect(
				(row().dropdownOptions ?? []).every(
					(option) => !option.disabled,
				),
			).toBe(true);
		});
	});

	describe('addDeleteSourceSetting', () => {
		it('renders the initial value and forward changes', () => {
			const onChange = jest.fn();
			addDeleteSourceSetting(containerEl, {
				desc: 'Delete.',
				initialValue: true,
				onChange,
			});

			expect(row().toggle?.value).toBe(true);

			row().changes.toggle?.(false);
			expect(onChange).toHaveBeenCalledWith(false);
		});
	});

	describe('addLinkActionSetting', () => {
		it('renders the three link actions and forward changes', () => {
			const onChange = jest.fn();
			addLinkActionSetting(containerEl, {
				desc: 'Links.',
				initialValue: 'replace',
				onChange,
			});

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(['none', 'replace', 'after']);
			expect(row().dropdownValue).toBe('replace');

			row().changes.dropdown?.('after');
			expect(onChange).toHaveBeenCalledWith('after');
		});
	});
});
