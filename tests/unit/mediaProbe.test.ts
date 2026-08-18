/**
 * Tests for the media-kind probe that decides whether the enhanced player
 * takes over a file (audio) or Obsidian's built-in embed is left in place
 * (video, unsupported). The probe loads metadata into a detached <video>
 * element, so that element is faked here to drive its loadedmetadata/error
 * events, dimensions, and the metadata timeout deterministically.
 */

import { probeMediaKind } from 'src/player/mediaProbe';
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
let createElementSpy: jest.SpyInstance;

beforeEach(() => {
	fakeVideo = makeFakeVideo();
	// The probe creates exactly one detached <video>; hand it the fake and
	// delegate any other tag to the real implementation.
	const realCreateElement = document.createElement.bind(document);
	createElementSpy = jest
		.spyOn(document, 'createElement')
		.mockImplementation((tag: string, options?: ElementCreationOptions) =>
			tag === 'video'
				? partial<HTMLElement>(fakeVideo)
				: realCreateElement(tag, options),
		);
});

afterEach(() => {
	createElementSpy.mockRestore();
});

describe('probeMediaKind', () => {
	it('classifies a file with video dimensions as video', async () => {
		const result = probeMediaKind('app://media');
		fakeVideo.videoWidth = 1920;
		fakeVideo.videoHeight = 1080;
		fakeVideo.fire('loadedmetadata');
		await expect(result).resolves.toEqual({
			kind: 'video',
			confident: true,
		});
	});

	it('classifies metadata without video dimensions as audio', async () => {
		const result = probeMediaKind('app://media');
		// videoWidth/videoHeight stay 0 -> audio-only
		fakeVideo.fire('loadedmetadata');
		await expect(result).resolves.toEqual({
			kind: 'audio',
			confident: true,
		});
	});

	it('classifies a load error as unsupported', async () => {
		const result = probeMediaKind('app://media');
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
			jest.advanceTimersByTime(4000);
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
		const result = probeMediaKind('app://media');
		fakeVideo.videoWidth = 100;
		fakeVideo.videoHeight = 100;
		fakeVideo.fire('loadedmetadata');
		await result;
		// The decoder is released so the probe never holds the media open
		expect(fakeVideo.removeAttribute).toHaveBeenCalledWith('src');
		expect(fakeVideo.load).toHaveBeenCalledTimes(1);
	});

	it('settles only once even if more events fire afterwards', async () => {
		const result = probeMediaKind('app://media');
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
