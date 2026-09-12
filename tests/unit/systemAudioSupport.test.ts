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
	type DisplayMediaHostOptions,
} from '../helpers/displayMediaHost';
import { usePlatform, withoutProcess } from '../helpers/hostProcess';

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
	 * Exposes an electron module and undoes it after the test, so a case
	 * that installs nothing really finds nothing.
	 * @param electron - What require('electron') should answer with
	 */
	function expose(electron: unknown): void {
		restore.push(useElectron(electron));
	}

	it('reports the grant on a Windows build that exposes the handler', () => {
		usePlatform('win32');
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
			usePlatform(platform);
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
		withoutProcess();
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
		usePlatform('win32');
		install();

		expect(isSystemAudioLoopbackAvailable()).toBe(false);
	});
});

describe('captureSystemAudioStream', () => {
	const realMediaDevices = navigator.mediaDevices;
	let restore: (() => void)[] = [];

	/** A live track that records whether it was stopped. */
	function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
		return partial<MediaStreamTrack>({
			kind,
			readyState: 'live',
			stop: jest.fn(),
		});
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

		await expect(captureSystemAudioStream()).rejects.toThrow('refused');

		expect(handlers[1]).toBeNull();
	});

	// A refused screen capture is not a refused microphone, and the two are
	// granted separately. Wrapped in an AudioStreamError the sentence began
	// "Failed to access audio device"; thrown bare, describeRecordingError
	// reads the NotAllowedError as a denied microphone and sends the user to
	// the microphone permission. Both name the wrong thing to go and fix.
	it('names the screen-capture permission when the grant is denied', async () => {
		const { getDisplayMedia } = withSession();
		getDisplayMedia.mockRejectedValue(
			new DOMException('Permission denied', 'NotAllowedError'),
		);

		const refusal = await captureSystemAudioStream().catch(
			(error: unknown) => error,
		);

		expect((refusal as Error).message).toContain(
			'the screen-capture permission rather than the microphone one',
		);
		expect((refusal as Error).message).not.toContain(
			'Failed to access audio device',
		);
	});

	// Everything else the host can answer with keeps its own reason, said
	// as something about this computer's output rather than about a device.
	it('keeps the reason a grant failed for anything but a refusal', async () => {
		const { getDisplayMedia } = withSession();
		getDisplayMedia.mockRejectedValue(new Error('capture pipeline died'));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			"This computer's output could not be captured: capture pipeline died",
		);
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

	// An answer nobody goes on to own still holds the screen capture open
	// through its video track, and the capture indicator with it, until
	// Obsidian is restarted.
	it('lets go of the video of an answer it refuses', async () => {
		const { getDisplayMedia } = withSession();
		const video = fakeTrack('video');
		getDisplayMedia.mockResolvedValue(grantedStream([video]));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			'not granted as audio',
		);

		expect(video.stop).toHaveBeenCalledTimes(1);
	});

	// Chromium ends a display capture through its video track, and whether
	// Electron's loopback audio hangs off that same capture is a property of
	// the build. Where it does, dropping the video hands back a stream whose
	// only track is already dead: the recorders are built on it, and the
	// session ends seconds in announcing a capture that stopped for no reason
	// the user can see.
	it('refuses a grant whose audio ends with the video it came with', async () => {
		const { getDisplayMedia } = withSession();
		let audioState: MediaStreamTrackState = 'live';
		const audio = partial<MediaStreamTrack>({
			kind: 'audio',
			stop: jest.fn(),
		});
		Object.defineProperty(audio, 'readyState', {
			get: () => audioState,
		});
		const video = partial<MediaStreamTrack>({
			kind: 'video',
			readyState: 'live',
			stop: jest.fn(() => {
				audioState = 'ended';
			}),
		});
		getDisplayMedia.mockResolvedValue(grantedStream([video, audio]));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			"This computer's output ended together with the screen capture",
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

	// The one host failure that arrives as an error rather than as an
	// absence. Left to propagate it reached the notice as the internal
	// wording of a remote-module failure, alone: every other refusal in this
	// module ends by saying what to record instead, and this one said
	// nothing a user could act on.
	it('says what to do instead when the source list refuses the call', async () => {
		const host = installDisplayMediaHost({
			sourceListFailure: 'An object could not be cloned',
		});
		restore.push(host.restore);

		const refusal = await captureSystemAudioStream().catch(
			(error: unknown) => error,
		);

		expect((refusal as Error).message).toBe(
			'The screens this machine offers could not be listed: An object ' +
				'could not be cloned. Record a loopback input device instead, ' +
				'such as Stereo Mix or VB-CABLE.',
		);
	});

	// getDisplayMedia consumes a transient activation, so it refuses a call
	// no user action led to. The plugin reaches it both ways: the ribbon
	// icon, the palette and a hotkey all carry one, and the CLI record
	// command carries none. Read as an unexplained failure, the sentence a
	// user got was the internal wording of that refusal followed by advice
	// about virtual cables, which is not what stopped them.
	it('names the missing user action rather than blaming the capture', async () => {
		const { getDisplayMedia } = withSession();
		getDisplayMedia.mockRejectedValue(
			new DOMException(
				'getDisplayMedia() requires transient activation',
				'InvalidStateError',
			),
		);

		const refusal = await captureSystemAudioStream().catch(
			(error: unknown) => error,
		);

		expect((refusal as Error).message).toContain(
			'granted only in answer to a user action in a focused Obsidian window',
		);
		expect((refusal as Error).message).not.toContain(
			'could not be captured:',
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

	// A refusal is the reason a capture was never attempted, and the user
	// reads it through describeRecordingError, which prints the message as
	// it stands. Wrapped in an AudioStreamError it arrived headed "Failed to
	// access audio device", naming a device a system-audio track has not
	// got, ahead of the sentence that says what to do instead.
	it('refuses with the reason alone, not as a device access failure', async () => {
		withSession({ platform: 'darwin' });

		const refusal = await captureSystemAudioStream().catch(
			(error: unknown) => error,
		);

		expect(refusal).not.toBeInstanceOf(AudioStreamError);
		expect((refusal as Error).message).toBe(
			'Recording the system output directly is granted on Windows only. ' +
				'Record a loopback input device instead, such as Stereo Mix, ' +
				'VB-CABLE or a PipeWire monitor.',
		);
	});
});
