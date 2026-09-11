/**
 * The rule every engine that reads only some containers applies to a payload:
 * pass the original bytes through where the endpoint takes them, decode the
 * rest to 16 kHz mono WAV, rename what was decoded so its type and its name
 * agree, and refuse a file neither the platform nor one request can take. Two
 * providers used to answer this separately and only one of them carried the
 * platform refusal, so the rule is pinned here rather than once per engine.
 * @module tests/unit/uploadContainer.test
 */

import {
	uploadContainer,
	type UploadCandidate,
	type UploadContainerRules,
	type UploadPart,
} from 'src/transcription/providers/uploadContainer';
import {
	MIME_TYPE_AUDIO_PREFIX,
	TRANSCRIBE_SAMPLE_RATE,
	WAV_MIME,
} from 'src/constants';
import { monoWavByteLength } from 'src/transcription/audioChunks';
import { DECODED_SAMPLE_COUNT } from '../mocks/modules/audioChunks';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';

// Decoding needs OfflineAudioContext, which jsdom lacks; mock the two audio
// helpers that touch it so the decode branch is observable by the bytes it
// hands back. The size arithmetic stays real, because it is what decides
// whether the decoded result fits one request.
jest.mock('src/transcription/audioChunks', () =>
	require('../mocks/modules/audioChunks'),
);

// The platform ceiling is a real byte count no fixture can reach, so the one
// answer these tests need is stubbed while the refusal wording stays real.
jest.mock('src/platform/capabilities', () => ({
	...jest.requireActual<typeof import('src/platform/capabilities')>(
		'src/platform/capabilities',
	),
	isDecodableSize: jest.fn(() => true),
}));

/** The containers the engines under test read, in each engine's own unit. */
const ACCEPTED_TYPES: ReadonlySet<string> = new Set([WAV_MIME, 'audio/mpeg']);

/**
 * An engine that reads WAV and MP3 by MIME type, with neither ceiling in reach.
 * Shaped like Gemini, which is the engine that publishes its list that way.
 */
const RULES = {
	accepts: ({ contentType }: UploadCandidate): boolean =>
		ACCEPTED_TYPES.has(contentType),
	engineLabel: 'Test Engine',
	acceptedContainers: 'mp3 or wav',
	maxRequestBytes: Number.POSITIVE_INFINITY,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
};

/** The largest WAV the double's decode produces, and so the boundary it tests. */
const DECODED_WAV_BYTES = monoWavByteLength(DECODED_SAMPLE_COUNT);

/** A ceiling one byte under that, which the decoded result has to overshoot. */
const CEILING_ONE_BYTE_SHORT = DECODED_WAV_BYTES - 1;

/** The exact duration the double's decode produces, and so its own boundary. */
const DECODED_SECONDS = DECODED_SAMPLE_COUNT / TRANSCRIBE_SAMPLE_RATE;

/** A duration cap one sample under that, which the decode has to overshoot. */
const CAP_ONE_SAMPLE_SHORT =
	(DECODED_SAMPLE_COUNT - 1) / TRANSCRIBE_SAMPLE_RATE;

/**
 * The upload a webm recording becomes under the given ceilings.
 *
 * webm is the container none of these engines read and the one this plugin
 * records by default, so it is what every decode case starts from; only the
 * ceiling under test differs, and naming the arrangement keeps that the only
 * thing each case spells out.
 * @param overrides - The rules this case varies
 * @returns The upload part, or the refusal it raised
 */
function decodedUpload(
	overrides: Partial<UploadContainerRules> = {},
): Promise<UploadPart> {
	return uploadContainer(payload('audio/webm', 'rec.webm'), {
		...RULES,
		...overrides,
	});
}

/** A payload as a vault file arrives, its name carrying its own extension. */
function payload(contentType: string, filename: string): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType,
		filename,
		offsetSeconds: 0,
	};
}

/** The mocked audio helpers, read back to assert what the decode branch did. */
function audioDoubles(): {
	decodeToMono16k: jest.Mock;
	encodeMonoWav: jest.Mock;
} {
	return jest.requireMock('src/transcription/audioChunks');
}

describe('a container the endpoint reads', () => {
	it('uploads the original bytes under their own type and name', async () => {
		const source = payload('audio/mpeg', 'rec.mp3');

		const part = await uploadContainer(source, RULES);

		expect(part).toEqual({
			data: source.data,
			contentType: 'audio/mpeg',
			filename: 'rec.mp3',
		});
	});
});

describe('a container the endpoint does not read', () => {
	it('renames the decoded part to match the bytes it now holds', async () => {
		// A WAV body still called `.webm` announces one container in the
		// part's header and another in its name, and a vendor client that
		// reads the type off the filename then contradicts the header - on
		// this plugin's default recording format.
		const part = await decodedUpload();

		expect(part.contentType).toBe(WAV_MIME);
		expect(part.filename).toBe('rec.wav');
	});

	it('declares a type and a name that agree about the container', async () => {
		// The type and the extension are one spelling in the constants, and
		// this is what that buys: a part whose header and whose filename
		// cannot name different containers. Derived from the part itself, so
		// re-splitting the two spellings fails here rather than at a vendor
		// that reads the container off the name.
		const part = await decodedUpload();

		expect(part.contentType).toBe(
			`${MIME_TYPE_AUDIO_PREFIX}${part.filename.split('.').pop() ?? ''}`,
		);
	});

	it('names a file that had no extension at all', async () => {
		const part = await uploadContainer(payload('audio/webm', 'rec'), RULES);

		expect(part.filename).toBe('rec.wav');
	});

	it('refuses a file too large for this platform to decode', async () => {
		// The decode expands the whole recording to PCM, and on a phone that
		// allocation is not a catchable error but the OS killing the WebView,
		// so the size is checked before the decode rather than after it.
		const { isDecodableSize } = jest.requireMock<{
			isDecodableSize: jest.Mock;
		}>('src/platform/capabilities');
		isDecodableSize.mockReturnValueOnce(false);

		await expect(decodedUpload()).rejects.toThrow(
			'File is too large to transcribe with Test Engine. Record or convert it to mp3 or wav, which this engine uploads without decoding.',
		);
		expect(audioDoubles().decodeToMono16k).not.toHaveBeenCalled();
	});
});

/**
 * The two ceilings a decoded upload is proven against, each set one step below
 * what the decode produces.
 *
 * Both answer the same question - will this recording fit one request - so both
 * refuse in the same words, and which of them binds is the engine's business
 * rather than this routine's. They are listed together so neither can be added
 * without the other being proven too: the byte one was there first, and the
 * duration one was missing while being the one that binds on Voxtral by hours.
 */
const OVER_EACH_CEILING = [
	{
		name: 'a decoded WAV larger than the request takes',
		overrides: { maxRequestBytes: CEILING_ONE_BYTE_SHORT },
	},
	{
		name: 'a recording longer than the endpoint takes',
		overrides: { maxRequestSeconds: CAP_ONE_SAMPLE_SHORT },
	},
] as const;

/** What each ceiling lets through when the decode lands exactly on it. */
const AT_EACH_CEILING = [
	{
		name: 'a decoded WAV that fills the request exactly',
		overrides: { maxRequestBytes: DECODED_WAV_BYTES },
	},
	{
		name: 'a recording that fills the duration exactly',
		overrides: { maxRequestSeconds: DECODED_SECONDS },
	},
] as const;

describe('a recording one request cannot carry', () => {
	it.each(OVER_EACH_CEILING)('refuses $name', async ({ overrides }) => {
		// The service proves a whole-file upload before the provider is reached,
		// but it proves the encoded bytes and has to assume the lowest plausible
		// bitrate, so a recording it cleared can still be hours past what the
		// endpoint takes - on Voxtral the duration binds at about 346 MB of this
		// WAV while the byte ceiling alone cleared roughly nine hours.
		await expect(decodedUpload(overrides)).rejects.toThrow(
			'Recording is too long to transcribe with Test Engine in one request. Split it into parts first.',
		);
	});

	it.each(OVER_EACH_CEILING)(
		'refuses $name before paying for the WAV',
		async ({ overrides }) => {
			// Proven between the decode and the encode, which is the earliest
			// either answer is knowable and still early enough to skip both the
			// second allocation and the upload.
			const { encodeMonoWav } = audioDoubles();

			await expect(decodedUpload(overrides)).rejects.toThrow(
				/too long to transcribe/,
			);
			expect(encodeMonoWav).not.toHaveBeenCalled();
		},
	);

	it.each(AT_EACH_CEILING)('accepts $name', async ({ overrides }) => {
		// The refusal is on "larger than", so the boundary itself is sent: a
		// recording that fills one request is not one request too many.
		const part = await decodedUpload(overrides);

		expect(part.contentType).toBe(WAV_MIME);
	});

	it('leaves the byte ceiling standing for an engine that states no duration', async () => {
		// An unbounded duration must not widen the byte ceiling, which is what
		// converting infinity into bytes would do if the two were not combined
		// by taking the smaller.
		await expect(
			decodedUpload({
				maxRequestBytes: CEILING_ONE_BYTE_SHORT,
				maxRequestSeconds: Number.POSITIVE_INFINITY,
			}),
		).rejects.toThrow(/too long to transcribe/);
	});
});

describe('the container an engine is asked about', () => {
	it('is named by both its type and its own extension', async () => {
		// The two engines publish their lists in different units, so the
		// question carries both and each reads the one it documents. A MIME set
		// could not state Mistral's list: the format registry gives `m4a` and
		// `mp4` one `audio/mp4`, and only the first is on it.
		const asked: UploadCandidate[] = [];

		await uploadContainer(payload('audio/mpeg', 'REC.MP3'), {
			...RULES,
			accepts: (container): boolean => {
				asked.push(container);
				return true;
			},
		});

		// Lowercased, so a list written in the vendor's own spelling matches a
		// file the user named in any other.
		expect(asked).toEqual([
			{ contentType: 'audio/mpeg', extension: 'mp3' },
		]);
	});

	it('is asked an empty extension for a name that carries none', async () => {
		const asked: string[] = [];

		await uploadContainer(payload('audio/mpeg', 'rec'), {
			...RULES,
			accepts: ({ extension }): boolean => {
				asked.push(extension);
				return true;
			},
		});

		expect(asked).toEqual(['']);
	});

	it('decodes a container the engine refuses on its extension alone', async () => {
		// The engine reads the type but not this name, which is how Voxtral
		// tells `m4a` from `mp4`: the decode branch has to be reachable from the
		// name, not only from the type.
		const part = await uploadContainer(payload(WAV_MIME, 'rec.unknown'), {
			...RULES,
			accepts: ({ extension }): boolean => extension === 'wav',
		});

		expect(part.filename).toBe('rec.wav');
		expect(audioDoubles().decodeToMono16k).toHaveBeenCalledTimes(1);
	});
});
