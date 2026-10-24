/**
 * The streamed split, run on the real mediabunny.
 *
 * Mediabunny decodes and encodes PCM itself, without WebCodecs, so a WAV
 * source split into WAV parts runs every step here that a compressed source
 * runs on a device - demux, decode, the cut between two decoded samples, one
 * encoder per part - and the parts can be compared with the source byte for
 * byte. The decoder hands samples over in 2048-frame packets, so every cut
 * below lands inside one, which is the case the cut exists for.
 * @module tests/unit/streamingSplit.test
 */

import {
	SPLIT_TAIL_SECONDS,
	StreamedSplit,
	StreamedSplitError,
} from 'src/audio/streamingSplit';
import {
	AdtsOutputFormat,
	AudioSampleSource,
	MkvOutputFormat,
	Output,
} from 'mediabunny';
import { assembleWavFromPcmSegments } from 'src/audio/WavEncoder';
import { parseWavLayout } from 'src/recording/AudioSplitter';
import { defined } from '../helpers/assertions';
import { internalsOf } from '../helpers/doubles';
import { flushMicrotasks } from '../helpers/async';
import {
	AAC_LC_STREAM,
	muxPlaceholderPackets,
} from '../helpers/encodedAudioFixtures';

/** Rate of the fixture, low so ten seconds stay small. */
const SAMPLE_RATE = 8000;

/** Length of the fixture: ten seconds. */
const FRAMES = SAMPLE_RATE * 10;

/**
 * A mono 16-bit WAV whose every frame holds a distinct value, so a frame that
 * lands in the wrong part, twice, or not at all shows up in a comparison.
 */
function sourceWav(): ArrayBuffer {
	const pcm = new Int16Array(FRAMES);
	for (let frame = 0; frame < FRAMES; frame++) {
		pcm[frame] = (frame % 60000) - 30000;
	}
	return assembleWavFromPcmSegments([pcm.buffer], 1, SAMPLE_RATE);
}

/**
 * The sample data of a WAV, as bytes.
 * @param wav - A whole WAV file
 */
function pcmOf(wav: ArrayBuffer): Uint8Array {
	const layout = defined(parseWavLayout(wav));
	return new Uint8Array(wav, layout.dataOffset, layout.dataLength);
}

/**
 * Opens the fixture for a split into WAV parts.
 * @param bytes - The source, the fixture unless a test supplies its own
 */
async function openSplit(bytes = sourceWav()): Promise<StreamedSplit> {
	return defined(await StreamedSplit.open(bytes, 'wav', 0));
}

describe('a streamed split', () => {
	it('cuts each part on the exact frame and loses none between them', async () => {
		const source = sourceWav();
		using split = await openSplit(source);

		const parts = [
			await split.nextPart(3 * SAMPLE_RATE),
			await split.nextPart(6 * SAMPLE_RATE),
			await split.nextPart(9 * SAMPLE_RATE),
			await split.nextPart(null),
		];

		// The parts laid end to end are the source, byte for byte: no frame
		// doubled at a cut, none dropped, and each cut inside a packet.
		expect(parts.map((part) => pcmOf(part).byteLength / 2)).toEqual([
			3 * SAMPLE_RATE,
			3 * SAMPLE_RATE,
			3 * SAMPLE_RATE,
			SAMPLE_RATE,
		]);
		const joined = new Uint8Array(
			parts.reduce((sum, part) => sum + pcmOf(part).byteLength, 0),
		);
		let offset = 0;
		for (const part of parts) {
			joined.set(pcmOf(part), offset);
			offset += pcmOf(part).byteLength;
		}
		expect(joined).toEqual(pcmOf(source));
	});

	it('reports the layout and rate the decoder produces', async () => {
		using split = await openSplit();

		expect({
			sampleRate: split.sampleRate,
			numberOfChannels: split.numberOfChannels,
		}).toEqual({ sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
	});

	it('plans the parts a little short of the length the container states', async () => {
		using split = await openSplit();

		// A plan reaching the stated end could open a last part after the
		// decoded audio has stopped, and that part would hold nothing.
		expect(split.plannedFrames).toBe(
			Math.floor((10 - SPLIT_TAIL_SECONDS) * SAMPLE_RATE),
		);
	});

	it('refuses a part that would begin after the audio ends, for the caller to fall back on', async () => {
		using split = await openSplit();
		await split.nextPart(null);

		await expect(split.nextPart(null)).rejects.toBeInstanceOf(
			StreamedSplitError,
		);
	});

	it('leaves out the frames a codec stamps before time zero', async () => {
		// Opus pre-skip and AAC behind an edit list decode to leading samples
		// stamped before zero. A whole-file decode leaves them out, so a
		// split counting them would cut every part that many frames early.
		const primed = await muxPlaceholderPackets(
			new MkvOutputFormat(),
			{
				codec: 'pcm-s16',
				decoderConfig: {
					codec: 'pcm-s16',
					sampleRate: SAMPLE_RATE,
					numberOfChannels: 1,
				},
				packetSeconds: 0.1,
			},
			10,
			0.1 * SAMPLE_RATE * 2,
			-0.05,
		);
		using split = defined(await StreamedSplit.open(primed, 'wav', 0));

		const part = await split.nextPart(null);

		expect(pcmOf(part).byteLength / 2).toBe(0.95 * SAMPLE_RATE);
	});

	it('answers null for bytes no container reader accepts', async () => {
		jest.spyOn(console, 'warn').mockImplementation();

		const split = await StreamedSplit.open(
			new Uint8Array(64).fill(7).buffer,
			'wav',
			0,
		);

		expect(split).toBeNull();
	});

	it('answers null where this device cannot encode the target format', async () => {
		// jsdom has no WebCodecs encoder, which is the device a split into
		// AAC parts cannot be streamed on.
		const split = await StreamedSplit.open(sourceWav(), 'aac', 128000);

		expect(split).toBeNull();
	});

	it('answers null where this device has no decoder for the codec', async () => {
		// AAC decodes through WebCodecs, which jsdom lacks: the device the
		// whole-file decode is kept for, such as a WebKit without it.
		const adts = await muxPlaceholderPackets(
			new AdtsOutputFormat(),
			AAC_LC_STREAM,
			8,
		);

		const split = await StreamedSplit.open(adts, 'wav', 0);

		expect(split).toBeNull();
	});

	it('answers null for a recording that decodes to nothing', async () => {
		const split = await StreamedSplit.open(
			assembleWavFromPcmSegments([], 1, SAMPLE_RATE),
			'wav',
			0,
		);

		expect(split).toBeNull();
	});

	it('turns an encoder failure into one the caller falls back on', async () => {
		using split = await openSplit();
		jest.spyOn(AudioSampleSource.prototype, 'add').mockRejectedValueOnce(
			new Error('encoder lost'),
		);

		const failure = split.nextPart(SAMPLE_RATE);

		await expect(failure).rejects.toBeInstanceOf(StreamedSplitError);
		await expect(failure).rejects.toThrow(
			'Splitting while decoding failed: encoder lost',
		);
	});

	it('cancels the part it was encoding when it fails', async () => {
		using split = await openSplit();
		jest.spyOn(AudioSampleSource.prototype, 'add').mockRejectedValueOnce(
			new Error('encoder lost'),
		);
		const cancel = jest.spyOn(Output.prototype, 'cancel');

		await split.nextPart(SAMPLE_RATE).catch(() => undefined);

		// The encoder behind the part is the platform's; one left open per
		// failed part is what a fallback run would then pile up beside.
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each(['start', 'finalize'] as const)(
		'cancels the part when the encoder fails to %s',
		async (step) => {
			using split = await openSplit();
			jest.spyOn(Output.prototype, step).mockRejectedValueOnce(
				new Error('encoder lost'),
			);
			const cancel = jest.spyOn(Output.prototype, 'cancel');

			await split.nextPart(SAMPLE_RATE).catch(() => undefined);

			expect(cancel).toHaveBeenCalledTimes(1);
		},
	);

	it('logs a decoder that fails to stop instead of leaving the rejection unhandled', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// Asserted below.
		});
		const split = await openSplit();
		const { samples } = internalsOf<{ samples: AsyncGenerator<unknown> }>(
			split,
		);
		const stopDecoder = samples.return.bind(samples);
		samples.return = (): Promise<never> =>
			Promise.reject(new Error('decoder gone'));

		split[Symbol.dispose]();
		await flushMicrotasks();
		// The stub left the real decoder running; stopping it closes the
		// samples it had already queued
		await stopDecoder(undefined);

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('could not stop the decoder'),
			expect.any(Error),
		);
	});

	it('refuses a part the encoder finished without writing', async () => {
		using split = await openSplit();
		jest.spyOn(Output.prototype, 'finalize').mockResolvedValueOnce();

		await expect(split.nextPart(SAMPLE_RATE)).rejects.toThrow(
			'The part encoder produced no output.',
		);
	});
});
