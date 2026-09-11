/**
 * What an engine that takes only some containers actually uploads.
 *
 * Two cloud engines share this shape: the endpoint lists the containers it
 * reads, and everything else - notably the `webm` this plugin records by
 * default - has to be decoded to 16 kHz mono WAV first. Both answered it in
 * their own words, and only one of them remembered that the decode is an
 * allocation the platform can refuse, so the guard existed on one engine and
 * not on its twin. One routine answers it for both, and a rule added here
 * cannot go missing from either.
 *
 * What differs between them is only the unit the list is published in, so that
 * is the one thing an engine states for itself: Google names MIME types, Mistral
 * names file extensions, and neither set can be rewritten as the other without
 * claiming a container its endpoint never listed.
 * @module transcription/providers/uploadContainer
 */

import { FORMAT_WAV, TRANSCRIBE_SAMPLE_RATE, WAV_MIME } from '../../constants';
import { isDecodableSize, tooLargeMessage } from '../../platform/capabilities';
import {
	decodeToMono16k,
	encodeMonoWav,
	monoWavByteLength,
} from '../audioChunks';
import type { AudioPayload } from './TranscriptionProvider';

/** Trailing extension of a file name, including its dot. */
const EXTENSION_PATTERN = /\.[^./\\]+$/;

/** One upload: the bytes and the two things that describe them. */
export interface UploadPart {
	data: ArrayBuffer;
	contentType: string;
	filename: string;
}

/** The two things that name the container a payload arrived in. */
export interface UploadCandidate {
	/** MIME type declared for the bytes. */
	readonly contentType: string;
	/** Lowercase extension of the filename without its dot, '' when it has none. */
	readonly extension: string;
}

/** What an engine says about itself to accept or refuse a container. */
export interface UploadContainerRules {
	/**
	 * Whether the endpoint reads this container as it stands, with no decode.
	 *
	 * A question rather than a set of MIME types, because the two engines
	 * publish the rule in different units and neither unit can state the other's
	 * list. Google documents the File API by MIME type; Mistral documents
	 * Voxtral by file extension, and this plugin's format registry maps two
	 * extensions (`m4a`, `mp4`) onto one `audio/mp4`, so a MIME set claiming
	 * Mistral's list would also claim the container it left out.
	 */
	readonly accepts: (container: UploadCandidate) => boolean;
	/** The engine's own name, which the refusal names the operation by. */
	readonly engineLabel: string;
	/** The containers to record or convert to instead, in the refusal's words. */
	readonly acceptedContainers: string;
	/**
	 * The engine's own per-request byte ceiling, the one its capabilities
	 * declare. The service proves a whole-file upload against it before the
	 * provider is reached, but it proves the *encoded* bytes, and a decode
	 * replaces them with something an order of magnitude larger - so the
	 * ceiling has to be proven again against what this routine actually hands
	 * back.
	 */
	readonly maxRequestBytes: number;
	/**
	 * The duration the endpoint refuses a single request past, in seconds, or
	 * `Number.POSITIVE_INFINITY` for an endpoint that states none.
	 *
	 * Separate from the byte ceiling because the two are separate limits and
	 * either can bind first, and asked here because this is the only place the
	 * real duration is known: the cheap proof the service runs before the
	 * provider reads bytes and has to assume the lowest plausible bitrate, while
	 * the decoded samples give the exact length. Without it an engine whose byte
	 * ceiling is the looser of the two uploaded hours of audio it had already
	 * been told would be declined.
	 */
	readonly maxRequestSeconds: number;
}

/**
 * What to tell a user whose recording decodes to more than one request can
 * carry.
 *
 * Deliberately not {@link tooLargeMessage}: that one answers a platform
 * ceiling, and its mobile wording sends the user to a desktop, which does not
 * help here because the limit belongs to the endpoint and is the same on every
 * device. Splitting the recording is what helps, and the plugin has a splitter
 * to point at.
 * @param engineLabel - The engine the request would have gone to
 * @returns The refusal, ready to show
 */
function tooLongForOneRequest(engineLabel: string): string {
	return (
		`Recording is too long to transcribe with ${engineLabel} in one ` +
		'request. Split it into parts first.'
	);
}

/**
 * The whole upload: the bytes, the type declared for them, and the name they
 * are sent under. The original container where the endpoint reads it, a
 * decoded 16 kHz mono WAV otherwise.
 *
 * The name travels with the other two rather than being taken from the payload
 * at the call site, because all three describe the same bytes and a decode
 * changes all three at once. Sending decoded WAV under the recording's own
 * `.webm` name announces one container in the part's header and another in its
 * filename, and a vendor client that derives a part's type from that filename
 * then contradicts the header - on these engines' most common input, this
 * plugin's default recording format.
 *
 * The platform's own ceiling is asked first, before any decode, because the
 * decode itself expands the file to full PCM and on a phone exceeding that is
 * not a catchable error but the OS killing the WebView. The engine's request
 * ceilings are asked once the samples exist and before they are encoded, which
 * is the earliest their answer is knowable and still early enough to skip both
 * the WAV allocation and the upload: the service's own proof runs on the encoded
 * bytes and has to assume the lowest plausible bitrate, so a recording it
 * cleared can still be hours past what the endpoint takes.
 * @param payload - The audio bytes and their metadata
 * @param rules - What this engine accepts, its ceiling, and how it refuses the rest
 * @returns The bytes to send, their content type, and their filename
 * @throws When the container needs a decode this platform or this engine cannot take
 */
export async function uploadContainer(
	payload: AudioPayload,
	rules: UploadContainerRules,
): Promise<UploadPart> {
	const [suffix] = EXTENSION_PATTERN.exec(payload.filename) ?? [];
	if (
		rules.accepts({
			contentType: payload.contentType,
			extension: suffix?.slice(1).toLowerCase() ?? '',
		})
	) {
		return {
			data: payload.data,
			contentType: payload.contentType,
			filename: payload.filename,
		};
	}
	if (!isDecodableSize(payload.data.byteLength)) {
		throw new Error(
			tooLargeMessage(`transcribe with ${rules.engineLabel}`, {
				desktopAdvice:
					`Record or convert it to ${rules.acceptedContainers}, ` +
					'which this engine uploads without decoding.',
			}),
		);
	}
	const samples = await decodeToMono16k(payload.data);
	// Both of the engine's ceilings bound this upload and the smaller one is
	// what applies, so the duration is converted into the byte ceiling's unit
	// and the two are compared once. The conversion is exact rather than a
	// proxy: 16 kHz mono 16-bit PCM is a fixed number of bytes per second, and
	// an engine that states no duration leaves the byte ceiling standing.
	const ceilingBytes = Math.min(
		rules.maxRequestBytes,
		monoWavByteLength(rules.maxRequestSeconds * TRANSCRIBE_SAMPLE_RATE),
	);
	if (monoWavByteLength(samples.length) > ceilingBytes) {
		throw new Error(tooLongForOneRequest(rules.engineLabel));
	}
	return {
		data: await encodeMonoWav(samples, TRANSCRIBE_SAMPLE_RATE),
		contentType: WAV_MIME,
		filename: `${payload.filename.replace(EXTENSION_PATTERN, '')}.${FORMAT_WAV}`,
	};
}
