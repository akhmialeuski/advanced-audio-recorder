/**
 * Unit tests for the system-audio availability probe.
 * @module tests/unit/systemAudioSupport.test
 */

import {
	captureSystemAudioStream,
	systemAudioGrantSupport,
} from 'src/recording/systemAudioSupport';
import { AudioStreamError } from 'src/errors';
import { partial } from '../helpers/doubles';
import {
	installDisplayMediaHost,
	useElectron,
	type DisplayMediaHostOptions,
} from '../helpers/displayMediaHost';
import {
	MAC_GRANT_FLOOR,
	useHostProcess,
	useMacHost,
	usePlatform,
	withoutProcess,
	type MacHost,
} from '../helpers/hostProcess';

/** Where macOS keeps the permission every macOS capture refusal names. */
const MAC_PERMISSION_PANE =
	'System Settings > Privacy & Security > Screen & System Audio Recording';

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

describe('systemAudioGrantSupport', () => {
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

	/**
	 * Runs the case on a Mac reporting these versions, with a host exposing
	 * both halves of a grant, so the versions are all that decides it.
	 * @param mac - What the Mac reports
	 */
	function onMac(mac: MacHost): void {
		useMacHost(mac);
		expose(electronWithHandler());
	}

	it('reports the grant on a Windows build that exposes the handler', () => {
		usePlatform('win32');
		expose(electronWithHandler());

		expect(systemAudioGrantSupport()).toEqual({
			refusal: null,
			permission: null,
		});
	});

	// Chromium captures a Mac's output through Apple's CoreAudio tap, which
	// macOS 14.2 introduced and which Electron 39 made the default. The
	// floor itself is a row, so an off-by-one in either comparison fails.
	it.each([
		{ name: 'at both floors', mac: MAC_GRANT_FLOOR },
		{
			// The configuration the grant was first verified on.
			name: 'reported in the issue',
			mac: { system: '27.0.1', electron: '43.7.7' },
		},
		{
			// Compared as numbers: as text, '14.10' sorts before '14.2'.
			name: 'with a two-digit minor macOS version',
			mac: { system: '14.10', electron: '39.0.0' },
		},
		{
			// A missing minor counts as zero rather than failing the parse.
			name: 'reporting a bare major macOS version',
			mac: { system: '26', electron: '39.0.0' },
		},
		{
			name: 'on an Electron pre-release of the first version',
			mac: { system: '15.0', electron: '39.0.0-beta.4' },
		},
	] satisfies { name: string; mac: MacHost }[])(
		'reports the grant on a Mac $name',
		({ mac }) => {
			onMac(mac);

			expect(systemAudioGrantSupport().refusal).toBeNull();
		},
	);

	// macOS hands the output only to an app the user allowed, and reads that
	// answer at launch. Said where the grant is available, because that is
	// where a user is about to be stopped by it.
	it('names the macOS permission where a Mac can be granted the output', () => {
		onMac(MAC_GRANT_FLOOR);

		expect(systemAudioGrantSupport().permission).toBe(
			'macOS hands its output only to an app allowed to record it. ' +
				`Allow Obsidian under ${MAC_PERMISSION_PANE} (Screen Recording ` +
				'on macOS 14), adding it with the + button if it is not listed, ' +
				'then quit and reopen Obsidian.',
		);
	});

	// Below either floor the request would still raise the screen-recording
	// prompt and then answer with an audio track that never carries a
	// sample, so the Mac is refused before the host is asked, naming which
	// of its versions is the reason.
	it.each([
		{
			name: 'macOS just below the floor',
			mac: { system: '14.1', electron: '43.7.7' },
			reason: 'needs macOS 14.2 or later, and this Mac runs macOS 14.1.',
		},
		{
			name: 'macOS 13, which has no CoreAudio tap',
			mac: { system: '13.6.7', electron: '43.7.7' },
			reason: 'needs macOS 14.2 or later, and this Mac runs macOS 13.6.7.',
		},
		{
			name: 'a macOS that does not report its version',
			mac: { electron: '43.7.7' },
			reason: 'this Mac runs a macOS that does not report its version.',
		},
		{
			name: 'a macOS that reports an empty version',
			mac: { system: '', electron: '43.7.7' },
			reason: 'this Mac runs a macOS that does not report its version.',
		},
		{
			name: 'an installer just below the Electron floor',
			mac: { system: '15.5', electron: '38.4.0' },
			reason: 'built on Electron 39 or later, and this one runs Electron 38.4.0.',
		},
		{
			name: 'an installer that does not report its Electron',
			mac: { system: '15.5' },
			reason: 'this one runs an Electron that does not report its version.',
		},
		{
			name: 'an Electron version that is not a version',
			mac: { system: '15.5', electron: 'unknown' },
			reason: 'built on Electron 39 or later',
		},
		{
			// macOS is named first: it is the floor no Obsidian update lifts.
			name: 'both below their floors',
			mac: { system: '13.0', electron: '38.0.0' },
			reason: 'needs macOS 14.2 or later, and this Mac runs macOS 13.0.',
		},
	] satisfies { name: string; mac: MacHost; reason: string }[])(
		'refuses the grant on $name',
		({ mac, reason }) => {
			onMac(mac);

			expect(systemAudioGrantSupport().refusal).toContain(reason);
		},
	);

	// Electron is updated only by running a new installer, so an Obsidian
	// kept current by its own updates can still run an old one. Told to
	// "update Obsidian", the user would update, still be refused, and have
	// no idea why.
	it('sends a Mac on an old Electron to the installer rather than to an update', () => {
		onMac({ system: '15.5', electron: '37.2.0' });

		expect(systemAudioGrantSupport().refusal).toBe(
			'Recording the system output directly on macOS needs an Obsidian ' +
				'installer built on Electron 39 or later, and this one runs ' +
				'Electron 37.2.0. Download and run the current installer from ' +
				"obsidian.md, since Obsidian's own updates do not replace it. " +
				'Record a loopback input device instead, such as BlackHole.',
		);
	});

	// A native call on the host process that throws must leave the answer
	// at "unknown" rather than take the settings tab down with it.
	it('refuses the grant on a Mac whose version lookup throws', () => {
		useHostProcess({
			platform: 'darwin',
			versions: { electron: '43.7.7' },
			getSystemVersion: () => {
				throw new Error('not available in this renderer');
			},
		});
		expose(electronWithHandler());

		expect(systemAudioGrantSupport().refusal).toContain(
			'a macOS that does not report its version',
		);
	});

	it('names no permission where the grant is refused', () => {
		onMac({ system: '13.6.7', electron: '43.7.7' });

		expect(systemAudioGrantSupport().permission).toBeNull();
	});

	// The capturer is the other half of the answer: a host that answers the
	// handler but hides it cannot complete a request, so reporting the
	// grant as available would promise a capture that fails.
	it('refuses the grant where the screen source list is out of reach', () => {
		const host = installDisplayMediaHost({ withoutCapturer: true });
		restore.push(host.restore);

		expect(systemAudioGrantSupport().refusal).toContain(
			'no screen source list',
		);
	});

	// Electron grants no loopback on Linux, so it is refused before the host
	// is even asked, with the loopback input that platform does offer.
	it('refuses the grant on Linux, pointing at a monitor input', () => {
		usePlatform('linux');
		expose(electronWithHandler());

		expect(systemAudioGrantSupport().refusal).toBe(
			'Recording the system output directly is granted on Windows and ' +
				'on macOS only. Record a loopback input device instead, such ' +
				'as a PipeWire monitor.',
		);
	});

	// Obsidian mobile is a WebView that declares no `process` at all, and an
	// undeclared name throws on the way to `?.` rather than answering
	// undefined. This is asked while the settings tree is built, which the
	// framework does once at plugin load, so throwing here took the whole
	// plugin down on mobile rather than hiding one row.
	it('refuses the grant where the runtime declares no process', () => {
		withoutProcess();
		expose(electronWithHandler());

		expect(systemAudioGrantSupport().refusal).not.toBeNull();
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

		expect(systemAudioGrantSupport().refusal).toContain(
			'no way to capture the system output',
		);
	});
});

describe('captureSystemAudioStream', () => {
	const realMediaDevices = navigator.mediaDevices;
	let restore: (() => void)[] = [];

	/**
	 * A track that records whether it was stopped.
	 * @param kind - What the track carries
	 * @param readyState - The state it arrives in, live unless a case says
	 * @returns The track
	 */
	function fakeTrack(
		kind: 'audio' | 'video',
		readyState: MediaStreamTrackState = 'live',
	): MediaStreamTrack {
		return partial<MediaStreamTrack>({
			kind,
			readyState,
			stop: jest.fn(),
		});
	}

	/**
	 * A video and an audio track the build holds open as one capture: both
	 * arrive live, and stopping the video ends the audio with it.
	 * @returns The video track, then the audio track
	 */
	function tracksEndingTogether(): MediaStreamTrack[] {
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
		return [video, audio];
	}

	/** One grant handed back to a display-media request. */
	type Grant = { video?: unknown; audio?: string };

	/**
	 * What the first handler the capture installed grants a request with,
	 * asked the way Electron asks it.
	 * @param handlers - The handlers the host recorded
	 * @returns Every grant the handler answered with
	 */
	function grantsOf(handlers: (unknown | null)[]): Grant[] {
		const handler = handlers[0] as (
			request: unknown,
			callback: (grant: Grant) => void,
		) => void;
		const granted: Grant[] = [];
		handler({}, (grant) => granted.push(grant));
		return granted;
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

		const granted = grantsOf(host.handlers);

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
	// the user can see. On a Mac it is told apart from the missing
	// permission, which hands the track over dead before the video is
	// touched: no permission changes a build holding the two as one.
	it.each([
		{ platform: 'win32', instead: 'such as Stereo Mix or VB-CABLE.' },
		{ platform: 'darwin', instead: 'such as BlackHole.' },
	])(
		'refuses a grant whose audio ends with the video it came with on $platform',
		async ({ platform, instead }) => {
			const { getDisplayMedia } = withSession({ platform });
			getDisplayMedia.mockResolvedValue(
				grantedStream(tracksEndingTogether()),
			);

			await expect(captureSystemAudioStream()).rejects.toThrow(
				new Error(
					"This computer's output ended together with the screen " +
						'capture it was granted alongside, which this build ' +
						'holds open as one. Record a loopback input device ' +
						`instead, ${instead}`,
				),
			);
		},
	);

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

	// A grant reads the electron module twice, once for the session and once
	// for the capturer, and only the session lookup sits inside a guard of
	// its own. A require that answers the first and fails the second has to
	// end in the refusal a user can act on, not in the loader's own wording.
	it('refuses for the missing source list when electron fails to load the second time', async () => {
		usePlatform('win32');
		let loads = 0;
		restore.push(
			useElectron(electronWithHandler(), () => {
				loads += 1;
				if (loads > 1) {
					throw new Error("Cannot find module 'electron'");
				}
			}),
		);

		await expect(captureSystemAudioStream()).rejects.toThrow(
			new Error(
				'This Obsidian build exposes no screen source list, which a ' +
					'system audio grant needs. Record a loopback input device ' +
					'instead.',
			),
		);
	});

	// Asked anyway on a platform Electron grants no loopback on, the request
	// still reaches getDisplayMedia, which raises the operating system's own
	// screen-share prompt and then answers with a stream carrying no audio.
	// A user who chose the system output would be shown a screen picker and
	// then told their screen had no sound in it. A Mac below the floors is
	// the same case: the screen-recording prompt, then a silent track.
	it.each([
		{ name: 'Linux', host: { platform: 'linux' } },
		{
			name: 'a Mac below the macOS floor',
			host: {
				platform: 'darwin',
				mac: { system: '13.6.7', electron: '43.7.7' },
			},
		},
		{
			name: 'a Mac below the Electron floor',
			host: {
				platform: 'darwin',
				mac: { system: '15.5', electron: '38.4.0' },
			},
		},
	] satisfies { name: string; host: DisplayMediaHostOptions }[])(
		'refuses $name before it asks the host',
		async ({ host }) => {
			const { handlers, getDisplayMedia } = withSession(host);

			await expect(captureSystemAudioStream()).rejects.toThrow(
				'Recording the system output directly',
			);

			expect(getDisplayMedia).not.toHaveBeenCalled();
			expect(handlers).toHaveLength(0);
		},
	);

	// A refusal is the reason a capture was never attempted, and the user
	// reads it through describeRecordingError, which prints the message as
	// it stands. Wrapped in an AudioStreamError it arrived headed "Failed to
	// access audio device", naming a device a system-audio track has not
	// got, ahead of the sentence that says what to do instead.
	it('refuses with the reason alone, not as a device access failure', async () => {
		withSession({ platform: 'linux' });

		const refusal = await captureSystemAudioStream().catch(
			(error: unknown) => error,
		);

		expect(refusal).not.toBeInstanceOf(AudioStreamError);
		expect((refusal as Error).message).toBe(
			'Recording the system output directly is granted on Windows and ' +
				'on macOS only. Record a loopback input device instead, such ' +
				'as a PipeWire monitor.',
		);
	});

	// The path is the same on a Mac as on Windows: the same handler, the
	// same loopback grant, the same video dropped. Only what a failure says
	// differs between them.
	it('grants the system output on a Mac at the floors', async () => {
		const host = withSession({ platform: 'darwin' });
		host.getDisplayMedia.mockResolvedValue(
			grantedStream([fakeTrack('video'), fakeTrack('audio')]),
		);

		const stream = await captureSystemAudioStream();

		const granted = grantsOf(host.handlers);
		expect(stream.getAudioTracks()).toHaveLength(1);
		expect(stream.getVideoTracks()).toHaveLength(0);
		expect(granted).toEqual([
			{
				video: { id: 'screen:0:0', name: 'Entire screen' },
				audio: 'loopback',
			},
		]);
	});

	// Every refusal on a Mac that the permission can cure sends the user to
	// the one pane that grants it, and offers the virtual device a Mac has
	// rather than the Windows ones. Stereo Mix and VB-CABLE do not exist
	// there, and a microphone permission has no bearing on any of these.
	it.each([
		{
			// What the issue reported: without the permission Electron
			// refuses the source list before any prompt is shown.
			name: 'the screen source list is refused',
			arrange: (): void => {
				const host = installDisplayMediaHost({
					platform: 'darwin',
					sourceListFailure: 'Failed to get sources.',
				});
				restore.push(host.restore);
			},
			said: 'macOS lists them only to an app allowed to record the screen.',
		},
		{
			name: 'the machine offers no screen',
			arrange: (): void => {
				const host = installDisplayMediaHost({
					platform: 'darwin',
					withoutScreens: true,
				});
				restore.push(host.restore);
			},
			said: 'This machine offered no screen to capture from',
		},
		{
			name: 'the grant is denied',
			arrange: (): void => {
				withSession({
					platform: 'darwin',
				}).getDisplayMedia.mockRejectedValue(
					new DOMException('Permission denied', 'NotAllowedError'),
				);
			},
			said: 'the screen and system audio recording permission rather than the microphone one',
		},
		{
			name: 'the answer carries no audio',
			arrange: (): void => {
				withSession({
					platform: 'darwin',
				}).getDisplayMedia.mockResolvedValue(
					grantedStream([fakeTrack('video')]),
				);
			},
			said: 'The system output was not granted as audio.',
		},
		{
			// Electron's own documentation: without the System Audio
			// Recording permission the track is created already ended and
			// never delivers a sample, and nothing is raised anywhere.
			name: 'the audio track arrives already ended',
			arrange: (): void => {
				withSession({
					platform: 'darwin',
				}).getDisplayMedia.mockResolvedValue(
					grantedStream([
						fakeTrack('video'),
						fakeTrack('audio', 'ended'),
					]),
				);
			},
			said: 'which is what it does when Obsidian is not allowed to record system audio.',
		},
	] satisfies { name: string; arrange: () => void; said: string }[])(
		'names the macOS permission when $name',
		async ({ arrange, said }) => {
			arrange();

			const message = await captureSystemAudioStream().catch(
				(error: unknown) => (error as Error).message,
			);

			expect(message).toContain(said);
			expect(message).toContain(
				`Allow Obsidian under ${MAC_PERMISSION_PANE} (Screen Recording ` +
					'on macOS 14), adding it with the + button if it is not ' +
					'listed, then quit and reopen Obsidian. Or record a ' +
					'loopback input device instead, such as BlackHole.',
			);
			expect(message).not.toContain('Stereo Mix');
		},
	);

	// The reason a Mac failed for keeps its own words, with the device a Mac
	// can route its output through rather than the Windows ones.
	it('offers BlackHole when a Mac fails for any other reason', async () => {
		const { getDisplayMedia } = withSession({ platform: 'darwin' });
		getDisplayMedia.mockRejectedValue(new Error('capture pipeline died'));

		await expect(captureSystemAudioStream()).rejects.toThrow(
			new Error(
				"This computer's output could not be captured: capture " +
					'pipeline died. Record a loopback input device instead, ' +
					'such as BlackHole.',
			),
		);
	});

	// A track dead on arrival was never alive to end with anything, so the
	// sentence about the screen capture taking it down would be false.
	it('tells a track that arrived ended from one the video took down on Windows', async () => {
		const { getDisplayMedia } = withSession();
		const video = fakeTrack('video');
		getDisplayMedia.mockResolvedValue(
			grantedStream([video, fakeTrack('audio', 'ended')]),
		);

		await expect(captureSystemAudioStream()).rejects.toThrow(
			new Error(
				"This computer's output was granted as a track that had " +
					'already ended, so there is nothing to record from it. ' +
					'Record a loopback input device instead, such as Stereo ' +
					'Mix or VB-CABLE.',
			),
		);
		expect(video.stop).toHaveBeenCalledTimes(1);
	});
});
