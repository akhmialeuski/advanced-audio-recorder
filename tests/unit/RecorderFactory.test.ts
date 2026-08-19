/**
 * Building the capture primitives a recording session runs on.
 *
 * These are three small factories, and their untested branches are the ones
 * that fire when the browser behaves unhelpfully: an empty chunk, a recorder
 * error, a torn-down session still receiving data. Getting any of them wrong
 * writes an unplayable file or crashes a stop.
 * @module tests/unit/RecorderFactory.test
 */

import {
	createAndStartMediaRecorders,
	createPcmRecorders,
	detachRecorderHandlers,
} from 'src/recording/RecorderFactory';
import { CHUNK_TIMESLICE_MS } from 'src/constants';
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';

/** A MediaRecorder double recording what the factory attached to it. */
interface RecorderDouble {
	stream: MediaStream;
	options: { mimeType: string; audioBitsPerSecond: number };
	start: jest.Mock;
	ondataavailable: ((event: { data: Blob }) => void) | null;
	onerror: ((event: Event) => void) | null;
}

const built: RecorderDouble[] = [];

beforeEach(() => {
	built.length = 0;
	(global as Record<string, unknown>).MediaRecorder = jest
		.fn()
		.mockImplementation((stream: MediaStream, options: never) => {
			const recorder: RecorderDouble = {
				stream,
				options,
				start: jest.fn(),
				ondataavailable: null,
				onerror: null,
			};
			built.push(recorder);
			return recorder;
		});
});

/** A stream stand-in; the factory only passes it through. */
function stream(name: string): MediaStream {
	return partial<MediaStream>({ id: name });
}

/** A blob of the given size, which is all the factory inspects. */
function chunk(size: number): Blob {
	return { size } as unknown as Blob;
}

describe('starting the media recorders', () => {
	it('builds one recorder per stream, in stream order', () => {
		createAndStartMediaRecorders(
			[stream('a'), stream('b')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk: jest.fn(), onError: jest.fn() },
		);

		expect(built).toHaveLength(2);
		expect(at(built, 0).stream).toBe(at(built, 0).stream);
		expect(at(built, 1).options.mimeType).toBe('audio/webm');
		expect(at(built, 1).options.audioBitsPerSecond).toBe(128000);
	});

	it('starts each one on the chunk timeslice', () => {
		// Without a timeslice the browser hands over one blob at stop, which
		// is what the incremental flush to disk exists to avoid.
		createAndStartMediaRecorders(
			[stream('a')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk: jest.fn(), onError: jest.fn() },
		);

		expect(at(built, 0).start).toHaveBeenCalledWith(CHUNK_TIMESLICE_MS);
	});

	it('reports each chunk against the track it came from', () => {
		const onChunk = jest.fn();
		createAndStartMediaRecorders(
			[stream('a'), stream('b')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk, onError: jest.fn() },
		);

		at(built, 1).ondataavailable?.({ data: chunk(64) });

		expect(onChunk).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				size: 64,
			}),
		);
	});

	it('drops an empty chunk rather than writing it', () => {
		// Browsers emit a zero-length blob at the end of a timeslice with no
		// audio; appending it to the part file corrupts the container.
		const onChunk = jest.fn();
		createAndStartMediaRecorders(
			[stream('a')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk, onError: jest.fn() },
		);

		at(built, 0).ondataavailable?.({ data: chunk(0) });

		expect(onChunk).not.toHaveBeenCalled();
	});

	it('reports an error against the track that raised it', () => {
		const onError = jest.fn();
		createAndStartMediaRecorders(
			[stream('a'), stream('b')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk: jest.fn(), onError },
		);
		const event = new Event('error');

		at(built, 1).onerror?.(event);

		expect(onError).toHaveBeenCalledWith(1, event);
	});
});

describe('discarding the media recorders', () => {
	it('detaches the handlers so a queued chunk reaches nothing', () => {
		// The browser can still deliver a chunk after stop; without this it
		// lands in a session that has already written its file.
		const onChunk = jest.fn();
		const recorders = createAndStartMediaRecorders(
			[stream('a')],
			{ mimeType: 'audio/webm', bitrate: 128000 },
			{ onChunk, onError: jest.fn() },
		);

		detachRecorderHandlers(recorders);

		expect(at(built, 0).ondataavailable).toBeNull();
		expect(at(built, 0).onerror).toBeNull();
	});
});

describe('building the PCM recorders', () => {
	it('builds one per stream, in stream order', () => {
		// The caller starts them itself, so it can read each one's negotiated
		// channel count and sample rate before any audio arrives.
		const recorders = createPcmRecorders(
			[stream('a'), stream('b')],
			48000,
			jest.fn(),
		);

		expect(recorders).toHaveLength(2);
		expect(
			(at(recorders, 0) as unknown as { stream: MediaStream }).stream,
		).toEqual({ id: 'a' });
	});

	it('reports each chunk against the track it came from', () => {
		const onChunk = jest.fn();
		const recorders = createPcmRecorders(
			[stream('a'), stream('b')],
			48000,
			onChunk,
		);
		const emit = (
			at(recorders, 1) as unknown as {
				onChunk: (data: ArrayBuffer) => void;
			}
		).onChunk;

		emit(new ArrayBuffer(8));

		expect(onChunk).toHaveBeenCalledWith(1, expect.any(ArrayBuffer));
	});

	it.each([
		{
			name: 'the mode given for that track',
			modes: ['mono-left'],
			expected: 'mono-left',
		},
		{
			name: 'the source layout when none was given',
			modes: [],
			expected: 'source',
		},
	])('captures with $name', ({ modes, expected }) => {
		const recorders = createPcmRecorders(
			[stream('a')],
			48000,
			jest.fn(),
			modes as never,
		);

		expect(
			(at(recorders, 0) as unknown as { channelMode: string })
				.channelMode,
		).toBe(expected);
	});
});
