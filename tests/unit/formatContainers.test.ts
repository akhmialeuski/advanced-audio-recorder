/**
 * The container each registered format is written in, checked against the
 * real mediabunny rather than its double.
 *
 * The double only records which constructor ran, so a registry entry naming
 * the wrong container passes every suite that uses it. That is how `.aac`
 * files came to hold MP4: the entry asked for `Mp4OutputFormat`, the double
 * built it, and nothing compared what was written with what the file was
 * called. The real writer knows the extension and the type of what it
 * writes, which is the comparison this suite makes.
 * @module tests/unit/formatContainers.test
 */

import * as engine from 'src/audio/mediabunnyRuntime';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import type { OutputFormat } from 'mediabunny';
import { getFormatDescriptor } from 'src/audio/formatRegistry';
import { FORMAT_AAC, FORMAT_M4A } from 'src/constants';
import { defined } from '../helpers/assertions';
import {
	AAC_LC_STREAM,
	muxPlaceholderPackets,
} from '../helpers/encodedAudioFixtures';

/**
 * The container a format's descriptor builds.
 * @param format - Registry format id
 */
function containerOf(format: string): OutputFormat {
	return defined(getFormatDescriptor(format)).createOutputFormat(engine);
}

describe('the container a format is written in', () => {
	it.each([
		{ format: 'wav', extension: '.wav' },
		{ format: 'webm', extension: '.webm' },
		{ format: 'ogg', extension: '.ogg' },
		{ format: 'mp3', extension: '.mp3' },
		{ format: 'mp4', extension: '.mp4' },
		{ format: 'flac', extension: '.flac' },
		{ format: 'aac', extension: '.aac' },
	])(
		'writes a .$format file as the container mediabunny names $extension',
		({ format, extension }) => {
			expect(containerOf(format).fileExtension).toBe(extension);
		},
	);

	it('writes m4a as the MP4 container under its Apple name', () => {
		// The one deliberate mismatch: m4a is MP4 with audio only, and the
		// extension is a convention rather than another container.
		expect(containerOf(FORMAT_M4A).fileExtension).toBe('.mp4');
	});

	it('declares the type of the .aac container it writes', () => {
		const descriptor = defined(getFormatDescriptor(FORMAT_AAC));

		expect(containerOf(FORMAT_AAC).mimeType).toBe(descriptor.mime);
	});

	it('frames an .aac file as ADTS, which a reader recognises from its first bytes', async () => {
		const bytes = new Uint8Array(
			await muxPlaceholderPackets(
				containerOf(FORMAT_AAC),
				AAC_LC_STREAM,
				3,
			),
		);

		// Twelve set bits are the ADTS sync word; an MP4 starts with a box
		// size and "ftyp" instead.
		expect(bytes[0]).toBe(0xff);
		expect((bytes[1] ?? 0) & 0xf0).toBe(0xf0);
	});

	it('writes an .aac file mediabunny reads back as AAC in ADTS', async () => {
		const file = await muxPlaceholderPackets(
			containerOf(FORMAT_AAC),
			AAC_LC_STREAM,
			3,
		);
		const input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();

		expect(await input.getMimeType()).toBe('audio/aac');
		expect(await track?.getCodec()).toBe('aac');
	});
});
