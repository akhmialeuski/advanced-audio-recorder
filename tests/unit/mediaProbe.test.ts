/**
 * Tests for the media-kind probe that decides whether the enhanced player
 * takes over a file (audio) or Obsidian's built-in embed is left in place
 * (video, unsupported).
 *
 * The probe reads the container's track list first, through the shared
 * mediabunny double, and loads metadata into a detached <video> element only
 * where the headers give no answer. That element is faked here to drive its
 * loadedmetadata/error events, dimensions, and the metadata timeout
 * deterministically.
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { probeMediaKind } from 'src/player/mediaProbe';
import {
	firstUrlSourceOptions,
	getMimeType,
	getPrimaryAudioTrack,
	getVideoTracks,
	inputDispose,
} from '../mocks/modules/mediabunny';
import { flushMicrotasks } from '../helpers/async';
import { partial } from '../helpers/doubles';

type Listener = () => void;

/** A controllable stand-in for the detached probe <video> element. */
interface FakeVideo {
	preload: string;
	muted: boolean;
	src: string;
	videoWidth: number;
	videoHeight: number;
	addEventListener: (type: string, cb: Listener) => void;
	removeAttribute: jest.Mock;
	load: jest.Mock;
	/** Test hook: fire the listeners registered for an event type. */
	fire: (type: string) => void;
}

function makeFakeVideo(): FakeVideo {
	const handlers = new Map<string, Listener[]>();
	return {
		preload: '',
		muted: false,
		src: '',
		videoWidth: 0,
		videoHeight: 0,
		addEventListener: (type, cb) => {
			const list = handlers.get(type) ?? [];
			list.push(cb);
			handlers.set(type, list);
		},
		removeAttribute: jest.fn(),
		load: jest.fn(),
		fire: (type) => {
			(handlers.get(type) ?? []).forEach((cb) => {
				cb();
			});
		},
	};
}

let fakeVideo: FakeVideo;

beforeEach(() => {
	fakeVideo = makeFakeVideo();
	// The probe creates at most one detached <video>; hand it the fake and
	// delegate any other tag to the real implementation.
	const realCreateElement = document.createElement.bind(document);
	jest.spyOn(document, 'createElement').mockImplementation(
		(tag: string, options?: ElementCreationOptions) =>
			tag === 'video'
				? partial<HTMLElement>(fakeVideo)
				: realCreateElement(tag, options),
	);
	// By default the headers are not a container mediabunny reads, which is
	// the case the element exists for.
	getVideoTracks.mockRejectedValue(
		new Error('Input has an unsupported or unrecognizable format.'),
	);
});

/**
 * Starts a probe that the headers cannot answer, and waits until it has
 * fallen through to the element, which is when the element's events mean
 * something.
 * @returns The pending result, wrapped so awaiting the helper does not
 * also await the probe
 */
async function probeByElement(): Promise<{
	result: ReturnType<typeof probeMediaKind>;
}> {
	const result = probeMediaKind('app://media');
	await flushMicrotasks(20);
	expect(fakeVideo.src).toBe('app://media');
	return { result };
}

/**
 * Scripts the headers of an audio-only container.
 * @param mimeType - The full type mediabunny reports for it
 * @param playable - What the browser answers when asked about that type
 */
function audioOnlyContainer(
	mimeType: string,
	playable: string,
): jest.SpyInstance {
	getVideoTracks.mockResolvedValue([]);
	getPrimaryAudioTrack.mockResolvedValue({});
	getMimeType.mockResolvedValue(mimeType);
	return jest
		.spyOn(HTMLMediaElement.prototype, 'canPlayType')
		.mockReturnValue(playable as CanPlayTypeResult);
}

describe('probeMediaKind from the container headers', () => {
	it('classifies a container with a video track as video, without loading it', async () => {
		getVideoTracks.mockResolvedValue([{}]);

		const result = await probeMediaKind('app://media');

		expect(result).toEqual({ kind: 'video', confident: true });
		expect(fakeVideo.src).toBe('');
	});

	it('classifies an audio-only container the browser plays as audio', async () => {
		const canPlay = audioOnlyContainer(
			'audio/webm; codecs="opus"',
			'probably',
		);

		const result = await probeMediaKind('app://media');

		// Asked with the codec parameters, which are what decides it: the
		// container alone does not say whether this codec plays here.
		expect(canPlay).toHaveBeenCalledWith('audio/webm; codecs="opus"');
		expect(result).toEqual({ kind: 'audio', confident: true });
		expect(fakeVideo.src).toBe('');
	});

	it.each([
		{
			name: 'are not a container mediabunny reads',
			arrange: (): void => {
				// The default: the double refuses the format.
			},
		},
		{
			name: 'list no audio track',
			arrange: (): void => {
				getVideoTracks.mockResolvedValue([]);
				getPrimaryAudioTrack.mockResolvedValue(null);
			},
		},
		{
			// A confident answer is kept for good, and a type string the
			// browser does not know is not proof it cannot play the file.
			name: 'name an audio type the browser does not recognise',
			arrange: (): void => {
				audioOnlyContainer('audio/mp4; codecs="alac"', '');
			},
		},
	])(
		'leaves a file whose headers $name to the element, which tries it',
		async ({ arrange }) => {
			arrange();

			const { result } = await probeByElement();
			fakeVideo.fire('loadedmetadata');

			expect((await result).confident).toBe(true);
		},
	);

	it('reads the headers by range, never retrying, and releases them', async () => {
		getVideoTracks.mockResolvedValue([{}]);

		await probeMediaKind('app://media');

		const { UrlSource } = jest.requireMock<{ UrlSource: jest.Mock }>(
			'mediabunny',
		);
		expect(UrlSource).toHaveBeenCalledWith(
			'app://media',
			firstUrlSourceOptions(),
		);
		expect(firstUrlSourceOptions().getRetryDelay?.(1)).toBeNull();
		expect(inputDispose).toHaveBeenCalledTimes(1);
	});

	it('gives a header read that does not answer up to the element', async () => {
		jest.useFakeTimers();
		try {
			getVideoTracks.mockReturnValue(new Promise(() => {}));

			const result = probeMediaKind('app://media');
			await jest.advanceTimersByTimeAsync(1000);

			// The stalled read was cancelled by disposing its input, and the
			// element took over with what is left of the probe's deadline.
			expect(inputDispose).toHaveBeenCalledTimes(1);
			expect(fakeVideo.src).toBe('app://media');
			fakeVideo.fire('loadedmetadata');
			await expect(result).resolves.toEqual({
				kind: 'audio',
				confident: true,
			});
		} finally {
			jest.useRealTimers();
		}
	});

	// The two readers share one deadline: a stalled header read and a silent
	// element together keep the embed waiting no longer than the element
	// alone used to.
	it('settles within one probe deadline when neither reader answers', async () => {
		jest.useFakeTimers();
		try {
			getVideoTracks.mockReturnValue(new Promise(() => {}));
			let settled: unknown = null;
			void probeMediaKind('app://media').then((value) => {
				settled = value;
			});

			await jest.advanceTimersByTimeAsync(4000);

			expect(settled).toEqual({ kind: 'audio', confident: false });
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('probeMediaKind through the element', () => {
	it('classifies a file with video dimensions as video', async () => {
		const { result } = await probeByElement();
		fakeVideo.videoWidth = 1920;
		fakeVideo.videoHeight = 1080;
		fakeVideo.fire('loadedmetadata');
		await expect(result).resolves.toEqual({
			kind: 'video',
			confident: true,
		});
	});

	it('classifies metadata without video dimensions as audio', async () => {
		const { result } = await probeByElement();
		// videoWidth/videoHeight stay 0 -> audio-only
		fakeVideo.fire('loadedmetadata');
		await expect(result).resolves.toEqual({
			kind: 'audio',
			confident: true,
		});
	});

	it('classifies a load error as unsupported', async () => {
		const { result } = await probeByElement();
		fakeVideo.fire('error');
		await expect(result).resolves.toEqual({
			kind: 'unsupported',
			confident: true,
		});
	});

	it('falls back to audio when metadata never arrives (timeout)', async () => {
		jest.useFakeTimers();
		try {
			const result = probeMediaKind('app://media');
			await jest.advanceTimersByTimeAsync(4000);
			// The fallback is usable now but flagged, so it is never persisted
			await expect(result).resolves.toEqual({
				kind: 'audio',
				confident: false,
			});
		} finally {
			jest.useRealTimers();
		}
	});

	it('releases the probe element after settling', async () => {
		const { result } = await probeByElement();
		fakeVideo.videoWidth = 100;
		fakeVideo.videoHeight = 100;
		fakeVideo.fire('loadedmetadata');
		await result;
		// The decoder is released so the probe never holds the media open
		expect(fakeVideo.removeAttribute).toHaveBeenCalledWith('src');
		expect(fakeVideo.load).toHaveBeenCalledTimes(1);
	});

	it('settles only once even if more events fire afterwards', async () => {
		const { result } = await probeByElement();
		fakeVideo.videoWidth = 100;
		fakeVideo.videoHeight = 100;
		fakeVideo.fire('loadedmetadata'); // first settle -> video
		fakeVideo.fire('error'); // must be ignored
		await expect(result).resolves.toEqual({
			kind: 'video',
			confident: true,
		});
		expect(fakeVideo.load).toHaveBeenCalledTimes(1);
	});
});
