/**
 * Copying packets without re-encoding, run on the real mediabunny.
 *
 * A copy needs no decoder and no encoder, so jsdom runs it whole, and the
 * same absence is what makes a refused copy visible here: where mediabunny
 * decides it cannot copy, it transcodes, which jsdom cannot, and the
 * conversion fails instead of quietly re-encoding at a quality nobody chose.
 * @module tests/unit/streamingRemux.test
 */

import { ALL_FORMATS, BufferSource, Input, Mp4OutputFormat } from 'mediabunny';
import { runStreamingConversion } from 'src/audio/streamingConversion';
import { FORMAT_AAC } from 'src/constants';
import {
	AAC_LC_STREAM,
	muxPlaceholderPackets,
} from '../helpers/encodedAudioFixtures';

/**
 * An MP4 holding placeholder AAC packets, the container iOS records into.
 * @param firstTimestamp - When the first packet starts
 */
async function mp4Recording(firstTimestamp: number): Promise<Blob> {
	return new Blob([
		await muxPlaceholderPackets(
			new Mp4OutputFormat(),
			AAC_LC_STREAM,
			40,
			16,
			firstTimestamp,
		),
	]);
}

/**
 * How many AAC frames an ADTS file holds, read back by the real demuxer.
 * @param bytes - The ADTS file
 */
async function adtsPacketCount(bytes: ArrayBuffer): Promise<number> {
	const input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	return (await track?.computePacketStats())?.packetCount ?? 0;
}

describe('copying AAC packets into an .aac file', () => {
	it('copies a recording that starts at zero', async () => {
		const converted = await runStreamingConversion(
			await mp4Recording(0),
			FORMAT_AAC,
			128000,
			true,
		);

		expect(await adtsPacketCount(converted)).toBe(40);
	});

	it('copies a recording whose priming starts it just before zero', async () => {
		// ADTS stamps no time on a frame, so mediabunny copies into it only a
		// stream that starts exactly at zero, and an encoder's priming puts
		// an AAC recording a few tens of milliseconds before it. Refused, the
		// copy became a transcode at mediabunny's default quality rather than
		// the session's bitrate - or, with no encoder, a failed save.
		const converted = await runStreamingConversion(
			await mp4Recording(-0.046),
			FORMAT_AAC,
			128000,
			true,
		);

		expect(await adtsPacketCount(converted)).toBe(40);
	});
});
