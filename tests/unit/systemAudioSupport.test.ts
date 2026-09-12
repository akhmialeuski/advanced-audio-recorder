/**
 * Unit tests for the system-audio availability probe.
 * @module tests/unit/systemAudioSupport.test
 */

import {
	captureSystemAudioStream,
	isSystemAudioLoopbackAvailable,
} from 'src/recording/systemAudioSupport';
import { AudioStreamError } from 'src/errors';
import { partial } from '../helpers/doubles';
import {
	installDisplayMediaHost,
	useElectron,
	usePlatform,
	withoutProcess,
	type DisplayMediaHostOptions,
} from '../helpers/displayMediaHost';

/**
 * An electron module with both halves a grant needs: the display-media
 * handler on the session, and a desktopCapturer to name a video source.
 */
function electronWithHandler(): unknown {
	return {
		remote: {
			getCurrentWebContents: () => ({
				session: { setDisplayMediaRequestHandler: (): void => {} },
			}),
			desktopCapturer: {
				getSources: (): Promise<never[]> => Promise.resolve([]),
			},
		},
	};
}

describe('isSystemAudioLoopbackAvailable', () => {
	let restore: (() => void)[] = [];

	afterEach(() => {
		restore.forEach((undo) => {
			undo();
		});
		restore = [];
	});

	/**
	 * Points the runtime at one platform for this test.
	 * @param platform - What process.platform should answer
	 */
	function onPlatform(platform: string): void {
		restore.push(usePlatform(platform));
	}

	/**
	 * Exposes an electron module and undoes it after the test, so a case
	 * that installs nothing really finds nothing.
	 * @param electron - What require('electron') should answer with
	 */
	function expose(electron: unknown): void {
		restore.push(useElectron(electron));
	}

	it('reports the grant on a Windows build that exposes the handler', () => {
		onPlatform('win32');
		expose(electronWithHandler());

		expect(isSystemAudioLoopbackAvailable()).toBe(true);
	});

	// Electron documents the loopback grant as Windows-only, so the other
	// platforms are refused before the host is even asked.
	// The capturer is the other half of the answer: a host that answers the
	// handler but hides it cannot complete a request, so reporting the
	// grant as available would promise a capture that fails.
	it('refuses the grant where the screen source list is out of reach', () => {
		const host = installDisplayMediaHost({ withoutCapturer: true });
		restore.push(host.restore);

		expect(isSystemAudioLoopbackAvailable()).toBe(false);
	});

	it.each([{ platform: 'darwin' }, { platform: 'linux' }])(
		'refuses the grant on $platform',
		({ platform }) => {
			onPlatform(platform);
			expose(electronWithHandler());

			expect(isSystemAudioLoopbackAvailable()).toBe(false);
		},
	);

	// Obsidian mobile is a WebView that declares no `process` at all, and an
	// undeclared name throws on the way to `?.` rather than answering
	// undefined. This is asked while the settings tree is built, which the
	// framework does once at plugin load, so throwing here took the whole
	// plugin down on mobile rather than hiding one row.
	it('refuses the grant where the runtime declares no process', () => {
		restore.push(withoutProcess());
		expose(electronWithHandler());

		expect(isSystemAudioLoopbackAvailable()).toBe(false);
	});

	// Every way the host can fail to offer the handler reads the same to a
	// caller: the grant is simply not available here.
	it.each([
		{
			absent: 'a desktop require',
			install: (): void => undefined,
		},
		{
			absent: 'the remote module',
			install: (): void => {
				expose({});
			},
		},
		{
			absent: 'a display-media handler on the session',
			install: (): void => {
				expose({
					remote: {
						getCurrentWebContents: () => ({ session: {} }),
					},
				});
			},
		},
		{
			// A host that refuses the lookup outright must read as "not
			// available" rather than take the settings tab down with it.
			absent: 'a lookup that answers at all',
			install: (): void => {
				restore.push(
					useElectron(
						new Proxy(
							{},
							{
								get: (): never => {
									throw new Error('blocked');
								},
							},
						),
					),
				);
			},
		},
	])('refuses the grant on Windows without $absent', ({ install }) => {
		onPlatform('win32');
		install();

		expect(isSystemAudioLoopbackAvailable()).toBe(false);
	});
});

describe('captureSystemAudioStream', () => {
	const realMediaDevices = navigator.mediaDevices;
	let restore: (() => void)[] = [];

	/** A track that records whether it was stopped. */
	function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
		return partial<MediaStreamTrack>({ kind, stop: jest.fn() });
	}

	/** A granted stream carrying the given tracks. */
	function grantedStream(tracks: MediaStreamTrack[]): MediaStream {
		const held = [...tracks];
		return partial<MediaStream>({
			getVideoTracks: () => held.filter((t) => t.kind === 'video'),
			getAudioTracks: () => held.filter((t) => t.kind === 'audio'),
			removeTrack: (track: MediaStreamTrack) => {
				held.splice(held.indexOf(track), 1);
			},
		});
	}

	/**
	 * Installs a host that can grant the system output, plus the display
	 * media call the capture makes against it.
	 * @param options - Which half of the host to leave missing, and the
	 *   platform to run it on
	 * @returns The handlers it recorded and the call to answer
	 */
	function withSession(options: DisplayMediaHostOptions = {}): {
		handlers: (unknown | null)[];
		getDisplayMedia: jest.Mock;
	} {
		const host = installDisplayMediaHost(options);
		restore.push(host.restore);
		const getDisplayMedia = jest.fn();
		Object.defineProperty(navigator, 'mediaDevices', {
			value: { getDisplayMedia },
			configurable: true,
		});
		return { handlers: host.handlers, getDisplayMedia };
	}

	afterEach(() => {
		restore.forEach((undo) => {
			undo();
		});
		restore = [];
		Object.defineProperty(navigator, 'mediaDevices', {
			value: realMediaDevices,
			configurable: true,
		});
	});

	it('asks for video it does not want, then hands back audio alone', async () => {
		const { getDisplayMedia } = withSession();
		const video = fakeTrack('video');
		getDisplayMedia.mockResolvedValue(
			grantedStream([video, fakeTrack('audio')]),
		);

		const stream = await captureSystemAudioStream();

		// The specification rejects a request whose video is false, so the
		// track has to be asked for and then let go of.
		expect(getDisplayMedia).toHaveBeenCalledWith({
			video: true,
			audio: true,
		});
		expect(stream.getVideoTracks()).toHaveLength(0);
		expect(stream.getAudioTracks()).toHaveLength(1);
		expect(video.stop).toHaveBeenCalledTimes(1);
	});

	// The handler is where the grant is actually asked for. Electron reads
	// the string 'loopback' as "give this page the machine's own output".
	// A request that asked for video and is granted none is refused by
	// Chromium as an invalid set of capture constraints, which is what a
	// grant of audio alone produced.
	it('answers the host request with a video source beside the loopback grant', async () => {
		const host = withSession();
		host.getDisplayMedia.mockResolvedValue(
			grantedStream([fakeTrack('audio')]),
		);
		await captureSystemAudioStream();
		const handler = host.handlers[0] as (
			request: unknown,
			callback: (grant: { video?: unknown; audio?: string }) => void,
		) => void;
		const granted: { video?: unknown; audio?: string }[] = [];

		handler({}, (grant) => granted.push(grant));

		expect(granted).toEqual([
			{
				video: { id: 'screen:0:0', name: 'Entire screen' },
				audio: 'loopback',
			},
		]);
	});

	// Left installed, the handler would decide every later display-media
	// request the host makes, including ones no plugin asked for.
	it('takes its handler back down after the request', async () => {
		const { handlers, getDisplayMedia } = withSession();
		getDisplayMedia.mockResolvedValue(grantedStream([fakeTrack('audio')]));

		await captureSystemAudioStream();

		expect(handlers).toHaveLength(2);
		expect(handlers[1]).toBeNull();
	});

	it('takes its handler back down when the request fails', async () => {
		const { handlers, getDisplayMedia } = withSession();
		getDisplayMedia.mockRejectedValue(new Error('refused'));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			AudioStreamError,
		);

		expect(handlers[1]).toBeNull();
	});

	// The specification lets a user agent answer a request for audio with
	// video alone, so an answer carrying no audio is a case to report.
	it('refuses an answer that carries no audio', async () => {
		const { getDisplayMedia } = withSession();
		getDisplayMedia.mockResolvedValue(grantedStream([fakeTrack('video')]));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'not granted as audio',
		);
	});

	// The capturer is the half that was missed, and missing it produced a
	// request Chromium refused rather than a sentence anyone could act on.
	it('refuses where the host offers no screen source list', async () => {
		const host = installDisplayMediaHost({ withoutCapturer: true });
		restore.push(host.restore);

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'no screen source list',
		);
	});

	it('refuses where the machine offers no screen', async () => {
		const host = installDisplayMediaHost({ withoutScreens: true });
		restore.push(host.restore);

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'no screen to capture from',
		);
	});

	it('refuses where the host exposes no handler at all', async () => {
		const host = installDisplayMediaHost({ withoutHandler: true });
		restore.push(host.restore);

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'no way to capture the system output',
		);
	});

	// Asked anyway on a platform Electron grants no loopback on, the request
	// still reaches getDisplayMedia, which raises the operating system's own
	// screen-share prompt and then answers with a stream carrying no audio.
	// A user who chose the system output would be shown a screen picker and
	// then told their screen had no sound in it.
	it('refuses a platform without the grant before it asks the host', async () => {
		const { handlers, getDisplayMedia } = withSession({
			platform: 'linux',
		});

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'granted on Windows only',
		);

		expect(getDisplayMedia).not.toHaveBeenCalled();
		expect(handlers).toHaveLength(0);
	});
});
