/**
 * Unit tests for the shared setting builders.
 * @module tests/unit/dialogSettingControls.test
 */

import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
	bitrateOfferNote,
	type BitrateRow,
} from 'src/settings/settingControls';
import {
	DEFAULT_SAMPLE_RATE,
	FORMAT_FLAC,
	FORMAT_MP3,
	FORMAT_WAV,
	FORMAT_WEBM,
} from 'src/constants';
import {
	getSupportedBitrates,
	resolveBitrateOffer,
	type BitrateOffer,
	type EncoderVerdict,
} from 'src/audio/AudioCapabilityDetector';
import { at } from '../helpers/assertions';
import { installAudioContextRate } from '../helpers/mediaMocks';
import { tick } from '../helpers/async';
import { capturedSettings } from '../helpers/captureSettings';
import type { CapturedSetting } from '../helpers/captureSettings';

// The full obsidian mock with only Setting swapped for the recording double.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

// The floors themselves are the format registry's business and are pinned in
// its own suite; here the detector is the shared double so the builder can be
// asked what it passes on and what it does with the answer.
jest.mock('src/audio/AudioCapabilityDetector', () =>
	require('../mocks/modules/audioCapabilityDetector'),
);

describe('dialog setting builders', () => {
	let containerEl: HTMLElement;

	/** The bitrates the detector double offers, in the order it offers them. */
	const OFFERED = [64000, 96000, 128000, 192000];

	/** A device whose AudioContext runs above the plugin's own default. */
	const DEVICE_RATE = 48000;

	beforeEach(() => {
		capturedSettings.length = 0;
		containerEl = document.createElement('div');
		// clearMocks keeps whatever a test installed, and these two carry the
		// list every case below starts from.
		jest.mocked(getSupportedBitrates).mockReturnValue([
			64000, 96000, 128000, 192000,
		]);
		jest.mocked(resolveBitrateOffer).mockResolvedValue({
			bitrates: [...OFFERED],
			encoder: 'unavailable',
		});
	});

	/**
	 * The single row these builders render.
	 * @returns The captured row
	 */
	function row(): CapturedSetting {
		return at(capturedSettings, 0);
	}

	/**
	 * Scripts what the encoder question resolves to.
	 * @param bitrates - The rates the row should end up offering
	 * @param encoder - What this device's encoder said about them
	 */
	function encoderOffers(
		bitrates: number[],
		encoder: EncoderVerdict = 'confirmed',
	): void {
		jest.mocked(resolveBitrateOffer).mockResolvedValue({
			bitrates,
			encoder,
		});
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
				initialBitrate: 128000,
				onChange: jest.fn(),
			});

			expect(jest.mocked(getSupportedBitrates)).toHaveBeenCalledWith(
				FORMAT_MP3,
				DEFAULT_SAMPLE_RATE,
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

		it('hides itself for a lossless target', () => {
			const bitrateRow = bitrateRowFor(FORMAT_FLAC);

			expect(row().el.style.display).toBe('none');
			bitrateRow.rebuild(FORMAT_WEBM);
			expect(row().el.style.display).not.toBe('none');
		});

		it('hides itself for a target that takes no bitrate', () => {
			const bitrateRow = bitrateRowFor();
			expect(row().el.style.display).not.toBe('none');

			bitrateRow.rebuild(FORMAT_WAV);

			expect(row().el.style.display).toBe('none');
		});

		it('offers only the bitrates this device can encode', async () => {
			// Narrowed, not dimmed. A native select keeps showing a disabled
			// option it already sits on, so dimming left the row displaying a
			// rate the encoder had just refused.
			encoderOffers([96000, 128000, 192000]);

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(['96000', '128000', '192000']);
			expect(
				(row().dropdownOptions ?? []).every(
					(option) => !option.disabled,
				),
			).toBe(true);
		});

		it('moves the selection onto a rate the encoder accepts', async () => {
			const onChange = jest.fn();
			encoderOffers([96000, 128000, 192000]);

			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 64000, onChange);
			await tick();

			expect(row().dropdownValue).toBe('96000');
			expect(bitrateRow.value).toBe(96000);
			expect(onChange).toHaveBeenCalledWith(96000);
		});

		it('leaves a selection the encoder accepts where it is', async () => {
			const onChange = jest.fn();
			encoderOffers([96000, 128000, 192000]);

			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 128000, onChange);
			await tick();

			expect(row().dropdownValue).toBe('128000');
			expect(bitrateRow.value).toBe(128000);
			expect(onChange).not.toHaveBeenCalled();
		});

		it('keeps a rate picked while the encoder was still being asked', async () => {
			// Registering a bundled encoder takes long enough for a dialog to
			// be used meanwhile. Snapping the answer onto the value the fill
			// started from put the old rate back into the select while the
			// dialog went on converting at the picked one, so the row showed
			// one bitrate and the file came out at another.
			const onChange = jest.fn();
			encoderOffers([64000, 96000, 128000, 192000]);

			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 128000, onChange);
			row().changes.dropdown?.('192000');
			await tick();

			expect({
				shown: row().dropdownValue,
				used: bitrateRow.value,
			}).toEqual({ shown: '192000', used: 192000 });
		});

		it('narrows a rate picked while it was being asked onto what the encoder takes', async () => {
			// The pick still has to obey the answer: what changes is that it
			// is the pick being narrowed, not the value the row opened with.
			const onChange = jest.fn();
			encoderOffers([64000, 96000]);

			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 64000, onChange);
			row().changes.dropdown?.('192000');
			await tick();

			expect({
				shown: row().dropdownValue,
				used: bitrateRow.value,
			}).toEqual({ shown: '96000', used: 96000 });
			expect(onChange).toHaveBeenLastCalledWith(96000);
		});

		it('says which values the codec reaches before the encoder answers', () => {
			bitrateRowFor(FORMAT_MP3);

			expect(row().desc).toContain('Bitrate.');
			expect(row().desc).toContain('kbps.');
		});

		it('says the encoder narrowed the list and where the low rates went', async () => {
			// The Windows case: AAC takes 96 kbps upward, and the whole point
			// of the low rates is a small speech file, so the row names the
			// formats that still write them instead of stopping at a refusal.
			encoderOffers([96000, 128000, 192000]);

			bitrateRowFor();
			await tick();

			expect(row().desc).toContain(
				'The encoder on this device accepts only the values listed.',
			);
			expect(row().desc).toContain('use WebM or OGG');
		});

		it('says the encoder confirmed the list when it took every value', async () => {
			encoderOffers([...OFFERED]);

			bitrateRowFor();
			await tick();

			expect(row().desc).toContain(
				'The encoder on this device accepts all of them.',
			);
		});

		it('says there is no encoder to ask when there is none', async () => {
			encoderOffers([...OFFERED], 'unavailable');

			bitrateRowFor();
			await tick();

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(OFFERED.map(String));
			expect(row().desc).toContain(
				'There is no encoder on this device to confirm them.',
			);
		});

		it('sends the user to the format when the encoder refused every rate', async () => {
			// No bitrate would help, so the row keeps the codec's range to show
			// and names what has to change instead.
			encoderOffers([...OFFERED], 'refused');

			bitrateRowFor();
			await tick();

			expect(row().desc).toContain('cannot write OPUS at 44.1 kHz.');
			expect(row().desc).toContain('use WebM or OGG');
		});

		it('drops an answer overtaken by a later target', async () => {
			// Two targets in flight at once: the answer for the one no longer
			// on screen must not re-offer a list it was never asked about.
			let settleWebm: (offer: BitrateOffer) => void = () => undefined;
			jest.mocked(resolveBitrateOffer).mockReturnValueOnce(
				new Promise((resolve) => {
					settleWebm = resolve;
				}),
			);
			const bitrateRow = bitrateRowFor();

			jest.mocked(getSupportedBitrates).mockReturnValue([128000, 192000]);
			encoderOffers([128000, 192000]);
			bitrateRow.rebuild(FORMAT_MP3);
			await tick();
			settleWebm({
				bitrates: [64000],
				encoder: 'confirmed',
			});
			await tick();

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(['128000', '192000']);
		});

		it('asks at the rate a conversion encodes at, not the plugin default', async () => {
			// Both dialogs decode their source through an AudioContext, which
			// resamples to the device's rate, so that is the rate the encoder
			// is handed. Asking at the plugin default described a file neither
			// dialog writes, and on a device whose encoder answers differently
			// at the two the row offered rates the conversion then refused.
			const device = installAudioContextRate(DEVICE_RATE);
			try {
				bitrateRowFor(FORMAT_MP3);
				await tick();
			} finally {
				device.restore();
			}

			expect(jest.mocked(resolveBitrateOffer)).toHaveBeenCalledWith(
				FORMAT_MP3,
				DEVICE_RATE,
				expect.any(Number),
			);
		});

		it('reports a failure to re-offer instead of leaving it unhandled', async () => {
			// The probe answers rather than throws, so what can reach here is
			// the DOM work on a row being torn down. An install where that
			// happens has no console to read an unhandled rejection from, and
			// the row would simply stop explaining itself.
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => {});
			const failure = new Error('offer failed');
			jest.mocked(resolveBitrateOffer).mockRejectedValueOnce(failure);

			bitrateRowFor();
			await tick();

			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not re-offer the bitrates'),
				failure,
			);
		});

		it('hides itself for a target outside the registry', () => {
			// A hand-edited extension, or one from a newer version: nothing is
			// known about its codec, so nothing can be promised about a rate.
			const bitrateRow = bitrateRowFor();

			bitrateRow.rebuild('aiff');

			expect(row().el.style.display).toBe('none');
		});

		it('narrows from the value asked for when the row is showing none', async () => {
			// A codec the plugin knows no rates for renders an empty select,
			// which shows nothing to read back. The value the row was asked
			// for is what the encoder's answer then has to be snapped onto:
			// reading the empty selection as the selection put the row on the
			// lowest rate the encoder happened to accept.
			const onChange = jest.fn();
			jest.mocked(getSupportedBitrates).mockReturnValue([]);
			encoderOffers([64000, 96000, 128000, 192000]);

			const bitrateRow = bitrateRowFor(FORMAT_WEBM, 190000, onChange);
			await tick();

			expect(bitrateRow.value).toBe(192000);
		});

		it('keeps the value asked for when nothing is on offer', () => {
			jest.mocked(getSupportedBitrates).mockReturnValue([]);

			expect(bitrateRowFor(FORMAT_WEBM, 111000).value).toBe(111000);
		});
	});

	describe('bitrateOfferNote', () => {
		it('names the codec and the range it reaches', () => {
			expect(bitrateOfferNote(FORMAT_MP3, 44100, null)).toBe(
				'MP3 at 44.1 kHz reaches 64-192 kbps.',
			);
		});

		it('falls back to the format id for a codec it does not know', () => {
			// A hand-edited extension, or one from a newer version. The row
			// still says which values it is offering and at what rate.
			expect(bitrateOfferNote('aiff', 48000, null)).toContain(
				'AIFF at 48 kHz reaches',
			);
		});

		it('does not point elsewhere when the list kept its low end', () => {
			// An encoder that drops the high end has taken nothing a speech
			// recording wanted, so the Opus pointer would only be noise.
			expect(
				bitrateOfferNote(FORMAT_MP3, 44100, {
					bitrates: [64000, 96000],
					encoder: 'confirmed',
				}),
			).not.toContain('use WebM or OGG');
		});

		it('says nothing when there is nothing on offer', () => {
			expect(
				bitrateOfferNote(FORMAT_MP3, 44100, {
					bitrates: [],
					encoder: 'confirmed',
				}),
			).toBe('');
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
