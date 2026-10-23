/**
 * Tests for the audio preparation helpers: extension-to-MIME mapping,
 * capability-derived prep options, the cheap whole-file path (sending the
 * original bytes untouched), the duration-cap proof, and the decode/split
 * path. The real decode needs the Web Audio API, so `decodeToMono16k` is
 * mocked to return synthetic samples of a chosen length; the chunk planning
 * and WAV encoding around it run for real.
 */

jest.mock('src/transcription/audioChunks', () => {
	const actual = jest.requireActual<
		typeof import('src/transcription/audioChunks')
	>('src/transcription/audioChunks');
	return { ...actual, decodeToMono16k: jest.fn() };
});

// The platform ceiling is a real byte count no fixture can reach, so the one
// answer these tests need is stubbed while the refusal wording stays real.
jest.mock('src/platform/capabilities', () => ({
	...jest.requireActual<typeof import('src/platform/capabilities')>(
		'src/platform/capabilities',
	),
	isDecodableSize: jest.fn(() => true),
}));

import {
	audioContainerFromExtension,
	audioPrepOptions,
	prepareAudio,
	sendsWholeFile,
	shouldWarnDiarizationSplit,
	withinDurationCap,
} from 'src/transcription/audioPrep';
import { at, defined } from '../helpers/assertions';
import { decodeToMono16k } from 'src/transcription/audioChunks';
import { isDecodableSize } from 'src/platform/capabilities';
import { useMobilePlatform } from '../helpers/platform';
import {
	MIN_SUBDIVIDE_SECONDS,
	TRANSCRIBE_BYTES_PER_SEC,
	TRANSCRIBE_SAMPLE_RATE,
} from 'src/constants';
import { WAV_HEADER_SIZE } from 'src/audio/WavEncoder';
import { UNLIMITED_CAPABILITIES } from '../helpers/providerFixtures';
import {
	DurationCapCheck,
	type AudioContainer,
	type ContainerSupport,
	type ProviderCapabilities,
} from 'src/transcription/providers/TranscriptionProvider';

const decodeMock = jest.mocked(decodeToMono16k);
const decodableMock = jest.mocked(isDecodableSize);

/** An engine that reads any container, as Whisper API and Deepgram do. */
const READS_EVERY_CONTAINER: ContainerSupport = { accepts: () => true };

/** An engine that reads none, as local whisper.cpp does. */
const READS_NO_CONTAINER: ContainerSupport = { accepts: () => false };

/** An engine that reads mp3 alone, with the words a refusal advises it by. */
const READS_MP3: ContainerSupport = {
	accepts: ({ extension }) => extension === 'mp3',
	acceptedNames: 'mp3',
};

/**
 * The container-side options of an engine that reads every container and
 * proves its duration cap through the byte size, which is how most of these
 * cases want preparation to behave around the limit each one varies.
 */
const READS_EVERYTHING = {
	durationCapCheck: DurationCapCheck.ProvenByBytes,
	originalContainers: READS_EVERY_CONTAINER,
	engineLabel: 'Test Engine',
};

/** The container of a file stored under this extension. */
function container(extension: string): AudioContainer {
	return audioContainerFromExtension(extension);
}

/** Synthetic 16 kHz mono samples spanning the given number of seconds. */
function samplesForSeconds(seconds: number): Float32Array {
	return new Float32Array(seconds * TRANSCRIBE_SAMPLE_RATE);
}

/** Encoded size of a WAV part covering `seconds` of 16 kHz mono audio. */
function wavBytesForSeconds(seconds: number): number {
	return WAV_HEADER_SIZE + seconds * TRANSCRIBE_BYTES_PER_SEC;
}

beforeEach(() => {
	decodeMock.mockReset();
	decodableMock.mockReturnValue(true);
});

describe('audioContainerFromExtension', () => {
	it('names the container by both its MIME type and its lowercase extension', () => {
		expect(audioContainerFromExtension('M4A')).toEqual({
			contentType: 'audio/mp4',
			extension: 'm4a',
		});
	});

	it.each([
		{ extension: 'mp3', type: 'audio/mpeg' },
		{ extension: 'wav', type: 'audio/wav' },
		{ extension: 'webm', type: 'audio/webm' },
		{ extension: 'flac', type: 'audio/flac' },
		{ extension: 'WAV', type: 'audio/wav' },
		{ extension: 'opus', type: 'audio/opus' },
	])('types $extension as $type', ({ extension, type }) => {
		expect(audioContainerFromExtension(extension).contentType).toBe(type);
	});
});

describe('withinDurationCap', () => {
	it('is always satisfied by an infinite cap', () => {
		expect(
			withinDurationCap(
				Number.MAX_SAFE_INTEGER,
				Number.POSITIVE_INFINITY,
			),
		).toBe(true);
	});

	it('proves a small file is within a finite cap', () => {
		// 900 s cap admits up to 900_000 bytes at the conservative min bitrate.
		expect(withinDurationCap(500_000, 900)).toBe(true);
		expect(withinDurationCap(900_000, 900)).toBe(true);
	});

	it('cannot prove a larger file short (falls through to decode)', () => {
		expect(withinDurationCap(900_001, 900)).toBe(false);
		expect(withinDurationCap(65 * 1024 * 1024, 900)).toBe(false);
	});
});

describe('audioPrepOptions', () => {
	/**
	 * An engine's declaration with only the limits a case varies spelled out.
	 * @param overrides - The fields this case is about
	 * @returns The capabilities to derive options from
	 */
	function capabilities(
		overrides: Partial<ProviderCapabilities>,
	): ProviderCapabilities {
		return { ...UNLIMITED_CAPABILITIES, ...overrides };
	}

	/** A network engine with the Whisper API's 25 MB request limit. */
	const networkCaps = capabilities({ maxRequestBytes: 25 * 1024 * 1024 });

	it('bounds the chunk size by the provider limit for network providers', () => {
		const options = audioPrepOptions(
			networkCaps,
			'Test Engine',
			true,
			100 * 1024 * 1024,
			false,
		);
		// 25 MB, less the header each part carries, is 819 whole seconds.
		expect(options.chunkSeconds).toBe(819);
		expect(options.maxRequestBytes).toBe(25 * 1024 * 1024);
		expect(options.maxRequestSeconds).toBe(Number.POSITIVE_INFINITY);
	});

	it('uses the user chunk size when it is under the provider limit', () => {
		const options = audioPrepOptions(
			networkCaps,
			'Test Engine',
			true,
			10 * 1024 * 1024,
			false,
		);
		// 10 MB, less the header, is 327 whole seconds.
		expect(options.chunkSeconds).toBe(327);
	});

	it('produces a single chunk for an unbounded local provider', () => {
		const options = audioPrepOptions(
			capabilities({ originalContainers: READS_NO_CONTAINER }),
			'Test Engine',
			false,
			10 * 1024 * 1024,
			false,
		);
		expect(options.chunkSeconds).toBe(Number.POSITIVE_INFINITY);
	});

	it('sizes parts by the duration cap, ignoring the user chunk size', () => {
		// A duration-capped provider chunks by time, not the user's MB setting.
		const options = audioPrepOptions(
			capabilities({
				maxRequestBytes: 2 * 1024 * 1024 * 1024,
				maxRequestSeconds: 900,
			}),
			'Test Engine',
			true,
			24 * 1024 * 1024,
			true,
		);
		// The cap itself, not the cap round-tripped through bytes: the header
		// allowance that conversion applies is a whole second at 16 kHz mono,
		// and 899 here is what made a fifteen-minute recording two parts.
		expect(options.chunkSeconds).toBe(900);
		expect(options.maxRequestSeconds).toBe(900);
	});

	it('carries the diarization flag and request limits through', () => {
		const options = audioPrepOptions(
			capabilities({ maxRequestBytes: 1000 }),
			'Test Engine',
			true,
			1000,
			true,
		);
		expect(options.diarize).toBe(true);
		expect(options.maxRequestSeconds).toBe(Number.POSITIVE_INFINITY);
	});

	it('carries what the engine reads, how its cap is held, and its name', () => {
		const declared = capabilities({
			durationCapCheck: DurationCapCheck.LeftToEndpoint,
			originalContainers: READS_MP3,
		});

		const options = audioPrepOptions(
			declared,
			'Test Engine',
			true,
			1000,
			false,
		);

		expect(options).toMatchObject({
			durationCapCheck: DurationCapCheck.LeftToEndpoint,
			originalContainers: READS_MP3,
			engineLabel: 'Test Engine',
		});
	});
});

describe('shouldWarnDiarizationSplit', () => {
	it('warns when a diarized run is split into parts', () => {
		expect(shouldWarnDiarizationSplit(2, true)).toBe(true);
	});

	it('does not warn for a single part', () => {
		expect(shouldWarnDiarizationSplit(1, true)).toBe(false);
	});

	it('does not warn when diarization was not requested', () => {
		expect(shouldWarnDiarizationSplit(3, false)).toBe(false);
	});
});

describe('sendsWholeFile', () => {
	/** Limits wide enough that only the field a row varies can decide. */
	const roomy = {
		maxRequestBytes: 10_000_000,
		maxRequestSeconds: 900,
		durationCapCheck: DurationCapCheck.ProvenByBytes,
		originalContainers: READS_MP3,
	};

	it.each([
		{
			name: 'a short file in a container the engine reads',
			bytes: 500,
			extension: 'mp3',
			options: roomy,
			whole: true,
		},
		{
			name: 'a short file in a container the engine does not read',
			bytes: 500,
			extension: 'webm',
			options: roomy,
			whole: false,
		},
		{
			name: 'a file past the byte limit',
			bytes: 10_000_001,
			extension: 'mp3',
			options: roomy,
			whole: false,
		},
		{
			name: 'a file its size cannot prove within the cap',
			bytes: 900_001,
			extension: 'mp3',
			options: roomy,
			whole: false,
		},
		{
			name: 'the same file when the endpoint holds the cap',
			bytes: 900_001,
			extension: 'mp3',
			options: {
				...roomy,
				durationCapCheck: DurationCapCheck.LeftToEndpoint,
			},
			whole: true,
		},
		{
			name: 'a file past the byte limit when the endpoint holds the cap',
			bytes: 10_000_001,
			extension: 'mp3',
			options: {
				...roomy,
				durationCapCheck: DurationCapCheck.LeftToEndpoint,
			},
			whole: false,
		},
		{
			name: 'a container the endpoint does not read when it holds the cap',
			bytes: 500,
			extension: 'webm',
			options: {
				...roomy,
				durationCapCheck: DurationCapCheck.LeftToEndpoint,
			},
			whole: false,
		},
	])('answers $whole for $name', ({ bytes, extension, options, whole }) => {
		expect(sendsWholeFile(bytes, container(extension), options)).toBe(
			whole,
		);
	});
});

/**
 * Prepares a file of the given container and size, named after its container.
 * @param extension - The file's container, as its extension
 * @param byteLength - How large the encoded file is
 * @param options - Provider-derived preparation options
 * @returns What preparation produced
 */
function prepareFile(
	extension: string,
	byteLength: number,
	options: Parameters<typeof prepareAudio>[3],
): ReturnType<typeof prepareAudio> {
	return prepareAudio(
		new Uint8Array(byteLength).buffer,
		`rec.${extension}`,
		container(extension),
		options,
	);
}

describe('prepareAudio (a container the engine does not read)', () => {
	const options = {
		maxRequestBytes: 10_000_000,
		maxRequestSeconds: Number.POSITIVE_INFINITY,
		durationCapCheck: DurationCapCheck.ProvenByBytes,
		originalContainers: READS_MP3,
		engineLabel: 'Test Engine',
		chunkSeconds: 60,
		diarize: false,
	};

	// A short webm fits every limit, and it used to be sent as it stood for
	// the provider to decode from the run's own buffer. The decode belongs
	// here, where the result is kept for every send of the part.
	it('decodes it to WAV even though it fits one request', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(3));

		const result = await prepareFile('webm', 500, options);

		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(result.payloads.map((part) => part.contentType)).toEqual([
			'audio/wav',
		]);
	});

	// The second pass and every retry materialize the part again, so each
	// call has to produce the whole WAV rather than share one buffer that an
	// earlier send might have given away.
	it('builds a fresh WAV each time the part is materialized', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(3));
		const part = at((await prepareFile('webm', 500, options)).payloads, 0);

		const first = await part.createData();
		const second = await part.createData();

		expect(second).not.toBe(first);
		expect(second.byteLength).toBe(wavBytesForSeconds(3));
	});

	it('refuses a file too large to decode with the containers that avoid the decode', async () => {
		decodableMock.mockReturnValue(false);

		await expect(prepareFile('webm', 500, options)).rejects.toThrow(
			'File is too large to transcribe with Test Engine. Record or convert it to mp3, which this engine uploads without decoding.',
		);
		expect(decodeMock).not.toHaveBeenCalled();
	});

	// The way out on a phone is the desktop, whatever the container, because
	// the ceiling there is the device's rather than the engine's.
	it('sends a phone user to the desktop instead', async () => {
		useMobilePlatform();
		decodableMock.mockReturnValue(false);

		await expect(prepareFile('webm', 500, options)).rejects.toThrow(
			'File is too large to transcribe with Test Engine on this device. Convert or split it on desktop instead.',
		);
	});

	// Converting would not help a file the engine reads already, which is
	// decoded only for being too long or too large for one request.
	it('gives the generic advice for a container the engine reads', async () => {
		decodableMock.mockReturnValue(false);

		await expect(prepareFile('mp3', 10_000_001, options)).rejects.toThrow(
			'File is too large to transcribe. Split it into parts first.',
		);
	});
});

describe('prepareAudio (a cap the endpoint holds)', () => {
	const options = {
		maxRequestBytes: 10_000_000,
		maxRequestSeconds: 2,
		durationCapCheck: DurationCapCheck.LeftToEndpoint,
		originalContainers: READS_MP3,
		engineLabel: 'Test Engine',
		chunkSeconds: 2,
		diarize: true,
	};

	it('sends a container the engine reads whole whatever its size proves', async () => {
		const result = await prepareFile('mp3', 500_000, options);

		expect(decodeMock).not.toHaveBeenCalled();
		expect(result.payloads.map((part) => part.contentType)).toEqual([
			'audio/mpeg',
		]);
	});

	// Once decoded the length is exact, so the cap the endpoint would have
	// refused after the upload is applied before it instead.
	it('splits a decoded recording at the cap', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(6));

		const result = await prepareFile('webm', 500, options);

		expect(result.payloads.map((part) => part.offsetSeconds)).toEqual([
			0, 2, 4,
		]);
		expect(result.diarizationSplitWarning).toBe(true);
	});
});

describe('prepareAudio (whole-file path)', () => {
	it('sends the original bytes untouched when within the limits', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', container('webm'), {
			maxRequestBytes: 1000,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			...READS_EVERYTHING,
			chunkSeconds: 60,
			diarize: false,
		});
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).createData()).toBe(raw);
		expect(at(result.payloads, 0).contentType).toBe('audio/webm');
		expect(at(result.payloads, 0).filename).toBe('rec.webm');
		expect(at(result.payloads, 0).offsetSeconds).toBe(0);
		expect(decodeMock).not.toHaveBeenCalled();
	});

	it('does not flag a diarization split when the whole file is sent', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await prepareAudio(raw, 'rec.webm', container('webm'), {
			maxRequestBytes: 1000,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			...READS_EVERYTHING,
			chunkSeconds: 60,
			diarize: true,
		});
		expect(result.diarizationSplitWarning).toBe(false);
	});

	it('sends a short file whole when the byte size proves it within the cap', async () => {
		const raw = new Uint8Array(500).buffer;
		const result = await prepareAudio(raw, 'rec.mp3', container('mp3'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 900,
			...READS_EVERYTHING,
			chunkSeconds: 900,
			diarize: true,
		});
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).createData()).toBe(raw);
		expect(result.diarizationSplitWarning).toBe(false);
		expect(decodeMock).not.toHaveBeenCalled();
	});
});

describe('prepareAudio (duration-cap decode path)', () => {
	it('decodes and splits a recording too long for one request, even within the byte limit', async () => {
		// 6 s of audio, parts of 2 s each: the byte size fits the limit but the
		// duration cap (2 s here) forces a decode-and-split into three parts.
		decodeMock.mockResolvedValue(samplesForSeconds(6));
		const raw = new Uint8Array(50_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', container('mp4'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 2,
			...READS_EVERYTHING,
			chunkSeconds: 2,
			diarize: true,
		});
		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(result.payloads).toHaveLength(3);
		expect(result.payloads.map((p) => p.offsetSeconds)).toEqual([0, 2, 4]);
		expect(result.payloads.map((p) => p.filename)).toEqual([
			'audio-0.wav',
			'audio-1.wav',
			'audio-2.wav',
		]);
		expect(at(result.payloads, 0).contentType).toBe('audio/wav');
		expect(result.diarizationSplitWarning).toBe(true);
	});

	it('does not warn about speakers when diarization is off', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(6));
		const raw = new Uint8Array(50_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', container('mp4'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 2,
			...READS_EVERYTHING,
			chunkSeconds: 2,
			diarize: false,
		});
		expect(result.payloads).toHaveLength(3);
		expect(result.diarizationSplitWarning).toBe(false);
	});

	// The threshold and the part size have to be one number. Deriving the part
	// from a byte round-trip made it a second smaller, so a recording of
	// exactly the cap came out as a full part plus a one-second sliver: an
	// extra billed request, and a speaker-numbering warning for a split that
	// carried no content.
	it('sends a recording of exactly the cap as one part', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(4));
		const raw = new Uint8Array(500_000).buffer;

		const result = await prepareAudio(raw, 'rec.mp4', container('mp4'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 4,
			...READS_EVERYTHING,
			chunkSeconds: 4,
			diarize: true,
		});

		expect(result.payloads).toHaveLength(1);
		expect(result.diarizationSplitWarning).toBe(false);
	});

	it('divides a recording just past the cap into parts of comparable length', async () => {
		decodeMock.mockResolvedValue(samplesForSeconds(5));
		const raw = new Uint8Array(500_000).buffer;

		const result = await prepareAudio(raw, 'rec.mp4', container('mp4'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 4,
			...READS_EVERYTHING,
			chunkSeconds: 4,
			diarize: false,
		});

		expect(result.payloads).toHaveLength(2);
		expect(at(result.payloads, 1).offsetSeconds).toBeCloseTo(2.5);
	});

	it('emits a single decoded part when the recording still fits the cap', async () => {
		// A 2 MB file exceeds the cheap byte proof (900 s admits < 0.9 MB), so it
		// is decoded; the measured duration then fits one part, so there is no
		// split and no speaker warning.
		decodeMock.mockResolvedValue(samplesForSeconds(2));
		const raw = new Uint8Array(2_000_000).buffer;
		const result = await prepareAudio(raw, 'rec.mp4', container('mp4'), {
			maxRequestBytes: 10_000_000,
			maxRequestSeconds: 900,
			...READS_EVERYTHING,
			chunkSeconds: 900,
			diarize: true,
		});
		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(result.payloads).toHaveLength(1);
		expect(at(result.payloads, 0).filename).toBe('audio.wav');
		expect(result.diarizationSplitWarning).toBe(false);
	});
});

describe('prepareAudio (a decoded part the provider still rejects)', () => {
	/**
	 * Prepares a recording the cheap byte proof cannot call short, so the
	 * duration comes from a real decode and the parts are real plans.
	 * @param decodedSeconds - Length the decode reports
	 * @param partSeconds - Duration cap, and so the length of one part
	 * @returns What preparation produced
	 */
	async function prepareDecoded(
		decodedSeconds: number,
		partSeconds: number,
	): Promise<Awaited<ReturnType<typeof prepareAudio>>> {
		decodeMock.mockResolvedValue(samplesForSeconds(decodedSeconds));
		return await prepareAudio(
			// Past the cheap byte proof: 500 kB cannot be argued short.
			new Uint8Array(500_000).buffer,
			'rec.mp4',
			container('mp4'),
			{
				maxRequestBytes: 10_000_000,
				maxRequestSeconds: partSeconds,
				...READS_EVERYTHING,
				chunkSeconds: partSeconds,
				diarize: false,
			},
		);
	}

	it('renders a decoded part into WAV only when it is about to be sent', async () => {
		// createData is deferred on purpose: a long recording holds one plan
		// per part, and rendering all of them up front would put the whole
		// decoded file in memory twice. Nothing had ever called it on the
		// decode path, so the deferral was untested where it matters.
		const result = await prepareDecoded(6, 2);

		const rendered = await at(result.payloads, 0).createData();

		expect(rendered.byteLength).toBe(wavBytesForSeconds(2));
		expect(at(result.payloads, 0).contentType).toBe('audio/wav');
	});

	it.each([
		// The rule is a floor, not a ratio: a part is only worth halving when
		// both halves would still be a minute of audio. Either side of that.
		{
			name: 'long enough to halve',
			seconds: MIN_SUBDIVIDE_SECONDS * 2,
			halves: 2,
		},
		{
			name: 'a second too short',
			seconds: MIN_SUBDIVIDE_SECONDS * 2 - 1,
			halves: 0,
		},
	])(
		'offers $halves halves for a part $name',
		async ({ seconds, halves }) => {
			// A provider can reject a part that fitted every limit the plan knew
			// about. subdivide is the retry, and nothing had ever called it - so
			// neither the split nor its floor was exercised.
			const result = await prepareDecoded(seconds, seconds);

			expect(defined(at(result.payloads, 0).subdivide)()).toHaveLength(
				halves,
			);
		},
	);

	it('gives each half its own name, span, and deferred render', async () => {
		const result = await prepareDecoded(
			MIN_SUBDIVIDE_SECONDS * 2,
			MIN_SUBDIVIDE_SECONDS * 2,
		);
		const whole = at(result.payloads, 0);

		const halves = defined(whole.subdivide)();

		expect(halves.map((half) => half.filename)).toEqual([
			'audio-0.wav',
			'audio-1.wav',
		]);
		// The halves tile the original span with no gap and no overlap, or a
		// retry would drop or repeat the audio between them.
		expect(at(halves, 0).offsetSeconds).toBe(whole.offsetSeconds);
		expect(at(halves, 0).endSeconds).toBe(at(halves, 1).offsetSeconds);
		expect(at(halves, 1).endSeconds).toBe(whole.endSeconds);
		// And each renders itself rather than sharing the parent's bytes.
		expect((await at(halves, 0).createData()).byteLength).toBe(
			wavBytesForSeconds(MIN_SUBDIVIDE_SECONDS),
		);
	});
});
