/**
 * Real container files built with the real mediabunny, for the suites that
 * need bytes a demuxer will accept.
 *
 * jsdom has no WebCodecs, so nothing here can encode audio. It does not have
 * to: a muxer only frames the packets it is handed, and a demuxer only reads
 * that framing, so packets of placeholder bytes with honest timing make a file
 * that every mediabunny reader parses exactly as it would a recording. What
 * such a file cannot do is decode, which is the line between the questions a
 * suite here may ask (containers, tracks, packet timing, copying) and the ones
 * it may not (samples).
 * @module tests/helpers/encodedAudioFixtures
 */

import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	Input,
	Output,
	type AudioCodec,
	type InputAudioTrack,
	type OutputFormat,
} from 'mediabunny';

/** AudioSpecificConfig for AAC-LC at 44.1 kHz, stereo (ISO/IEC 14496-3). */
const AAC_LC_44100_STEREO = new Uint8Array([0x12, 0x10]);

/** Frames one AAC packet carries. */
export const AAC_FRAMES_PER_PACKET = 1024;

/** Shape of the stream a fixture describes. */
export interface EncodedStream {
	/** Codec the packets claim to be. */
	readonly codec: AudioCodec;
	/** Decoder configuration the first packet carries. */
	readonly decoderConfig: AudioDecoderConfig;
	/** Length of one packet, in seconds. */
	readonly packetSeconds: number;
}

/** AAC-LC at 44.1 kHz stereo, the stream an AAC encoder hands a muxer. */
export const AAC_LC_STREAM: EncodedStream = {
	codec: 'aac',
	decoderConfig: {
		codec: 'mp4a.40.2',
		sampleRate: 44100,
		numberOfChannels: 2,
		description: AAC_LC_44100_STEREO,
	},
	packetSeconds: AAC_FRAMES_PER_PACKET / 44100,
};

/** Opus at 48 kHz mono in 20 ms packets, what MediaRecorder writes. */
export const OPUS_STREAM: EncodedStream = {
	codec: 'opus',
	decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 },
	packetSeconds: 0.02,
};

/**
 * Muxes placeholder packets into a container.
 * @param format - Container to write
 * @param stream - What the packets claim to be
 * @param packetCount - How many packets to write
 * @param packetBytes - Size of each packet's placeholder payload
 * @param firstTimestamp - When the first packet starts, in seconds; below
 *   zero for a stream that primes its decoder before the recording begins
 * @returns The finished file
 */
export async function muxPlaceholderPackets(
	format: OutputFormat,
	stream: EncodedStream,
	packetCount: number,
	packetBytes = 16,
	firstTimestamp = 0,
): Promise<ArrayBuffer> {
	const target = new BufferTarget();
	const output = new Output({ format, target });
	const source = new EncodedAudioPacketSource(stream.codec);
	output.addAudioTrack(source);
	await output.start();
	for (let index = 0; index < packetCount; index++) {
		const packet = new EncodedPacket(
			new Uint8Array(packetBytes).fill(index % 256),
			'key',
			firstTimestamp + index * stream.packetSeconds,
			stream.packetSeconds,
		);
		await source.add(
			packet,
			index === 0 ? { decoderConfig: stream.decoderConfig } : undefined,
		);
	}
	await output.finalize();
	if (!target.buffer) {
		throw new Error('The muxer produced no file');
	}
	return target.buffer;
}

/**
 * Reads a file back through the real demuxer: opens it, hands its primary
 * audio track and the input to `read`, and releases the input however `read`
 * ends.
 * @param bytes - The file to read
 * @param read - What to learn from the track
 * @returns What `read` returned
 * @throws Error when the file has no audio track
 */
export async function withPrimaryAudioTrack<T>(
	bytes: ArrayBuffer,
	read: (track: InputAudioTrack, input: Input) => Promise<T>,
): Promise<T> {
	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('The file has no audio track');
	}
	return await read(track, input);
}
