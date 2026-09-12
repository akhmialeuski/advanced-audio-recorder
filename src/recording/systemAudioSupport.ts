/**
 * Whether this host can hand the plugin the machine's own output as a stream.
 *
 * Obsidian registers no display-media request handler of its own, so a bare
 * `navigator.mediaDevices.getDisplayMedia` call fails here. A plugin may
 * register one for the length of a single request through Electron's remote
 * module, and Electron grants system audio only on Windows. Both halves of
 * that answer are runtime facts about the installed build rather than policy,
 * which is why they are probed here and not declared in
 * {@link module:platform/capabilities}.
 *
 * The capture itself lives here too, because it is the same three facts read
 * twice: the handler, the platform, and the grant.
 * @module recording/systemAudioSupport
 */

import { AudioStreamError } from '../errors';

/** One grant handed back to a display-media request. */
interface DisplayMediaGrant {
	video?: unknown;
	audio?: string;
}

/** The part of an Electron session this plugin reaches for. */
interface DisplayMediaSession {
	setDisplayMediaRequestHandler?: (
		handler:
			| ((
					request: unknown,
					callback: (streams: DisplayMediaGrant) => void,
			  ) => void)
			| null,
		options?: { useSystemPicker: boolean },
	) => void;
}

/** One screen or window Electron offers as a capture source. */
interface DesktopCapturerSource {
	id: string;
	name: string;
}

/** The part of Electron's desktopCapturer this plugin reaches for. */
interface DesktopCapturer {
	getSources: (options: {
		types: string[];
		thumbnailSize?: { width: number; height: number };
	}) => Promise<DesktopCapturerSource[]>;
}

/** The part of Electron's remote module this plugin reaches for. */
interface ElectronRemote {
	getCurrentWebContents?: () => { session?: DisplayMediaSession } | undefined;
	getBuiltin?: (name: string) => unknown;
	desktopCapturer?: unknown;
	require?: (id: string) => { desktopCapturer?: unknown };
}

/** Platform Electron grants a system-audio loopback stream on. */
const LOOPBACK_GRANT_PLATFORM = 'win32';

/** The grant that asks Electron for the machine's own output. */
const LOOPBACK_GRANT = 'loopback';

/**
 * The Electron session this window runs in, or null where the host exposes
 * no way to reach it. Read through the same desktop `require` the local
 * transcription engine uses, so a mobile build (which has none) answers null
 * rather than throwing.
 * @returns The session, or null
 */
function electronModule(): { remote?: ElectronRemote } | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		return req('electron') as { remote?: ElectronRemote };
	} catch {
		// A host without the module, or one that refuses the lookup.
		return null;
	}
}

/**
 * The Electron session this window runs in, or null where the host exposes
 * no way to reach it.
 * @returns The session, or null
 */
function currentElectronSession(): DisplayMediaSession | null {
	try {
		const remote = electronModule()?.remote;
		return remote?.getCurrentWebContents?.()?.session ?? null;
	} catch {
		return null;
	}
}

/**
 * Electron's desktopCapturer, or null where it cannot be reached.
 *
 * A grant has to name a video source even when only audio is wanted, and
 * only desktopCapturer produces one. It is a main-process module, so a
 * renderer reaches it through the remote module, which exposes it under
 * several names depending on the Electron version. Each is tried in turn
 * rather than picked, because which one answers is a property of the host.
 * @returns The capturer, or null
 */
function desktopCapturer(): DesktopCapturer | null {
	const electron = electronModule();
	const remote = electron?.remote;
	const candidates = [
		(): unknown => remote?.getBuiltin?.('desktopCapturer'),
		(): unknown => remote?.desktopCapturer,
		(): unknown => remote?.require?.('electron').desktopCapturer,
		(): unknown =>
			(electron as { desktopCapturer?: unknown } | null)?.desktopCapturer,
	];
	for (const read of candidates) {
		try {
			const found = read() as DesktopCapturer | undefined;
			if (typeof found?.getSources === 'function') {
				return found;
			}
		} catch {
			// This route is closed on this host; the next one may not be.
		}
	}
	return null;
}

/**
 * Whether a system-audio stream can be granted on this build and platform.
 *
 * Reported in the System info snapshot so a user can say what their install
 * is capable of without being walked through a developer console.
 * @returns True when both the handler and the platform grant are available
 */
export function isSystemAudioLoopbackAvailable(): boolean {
	if (process?.platform !== LOOPBACK_GRANT_PLATFORM) {
		return false;
	}
	const session = currentElectronSession();
	// Both halves are needed. A grant names a video source even when only
	// audio is wanted, so a host that answers the handler but hides the
	// capturer cannot complete a request, and reporting it as available
	// would promise a capture that fails at the start of a recording.
	return (
		typeof session?.setDisplayMediaRequestHandler === 'function' &&
		desktopCapturer() !== null
	);
}

/**
 * The machine's own output as a capture stream, audio only.
 *
 * Three things about `getDisplayMedia` shape this, and each one breaks a
 * naive call:
 *
 * - The specification rejects a request whose `video` is false with a
 *   `TypeError`, so video has to be asked for and thrown away.
 * - `audio: true` does not oblige the user agent to return an audio track,
 *   so an answer carrying none is a case to report rather than to assume.
 * - Electron grants system audio through `audio: 'loopback'` on Windows
 *   alone, which is why {@link isSystemAudioLoopbackAvailable} gates this.
 *
 * The handler is installed for the length of this one request and taken back
 * down in `finally`, so the plugin never leaves the host application with a
 * display-media policy of its own.
 * @returns A stream carrying one audio track of the system output
 * @throws AudioStreamError when the host, the platform, or the answer cannot
 *   provide one
 */
export async function captureSystemAudioStream(): Promise<MediaStream> {
	const session = currentElectronSession();
	const install = session?.setDisplayMediaRequestHandler;
	if (!install) {
		throw new AudioStreamError(
			new Error(
				'This Obsidian build exposes no way to capture the system output. ' +
					'Record a loopback input device instead.',
			),
		);
	}
	const capturer = desktopCapturer();
	if (!capturer) {
		throw new AudioStreamError(
			new Error(
				'This Obsidian build exposes no screen source list, which a system ' +
					'audio grant needs. Record a loopback input device instead.',
			),
		);
	}
	let installed = false;
	try {
		// Listed before the request rather than inside the handler: the
		// handler is synchronous from Electron's point of view, and a grant
		// that arrives late is a grant that never arrived.
		const [screen] = await capturer.getSources({
			types: ['screen'],
			// No thumbnails: the frames would be captured, decoded and then
			// thrown away with the video track.
			thumbnailSize: { width: 0, height: 0 },
		});
		if (!screen) {
			throw new AudioStreamError(
				new Error('This machine offered no screen to capture from.'),
			);
		}
		install.call(session, (_request, callback) => {
			// The video source is required even though only audio is kept:
			// a request that asked for video and is granted none is refused
			// by Chromium as an invalid set of capture constraints.
			callback({ video: screen, audio: LOOPBACK_GRANT });
		});
		installed = true;
		const granted = await navigator.mediaDevices.getDisplayMedia({
			// Asked for and dropped below: a request without it is refused.
			video: true,
			audio: true,
		});
		return audioOnly(granted);
	} catch (error) {
		throw error instanceof AudioStreamError
			? error
			: new AudioStreamError(
					error instanceof Error ? error : new Error(String(error)),
				);
	} finally {
		// Only ours is taken back down. Clearing unconditionally would also
		// clear a handler this plugin never installed, which on a failure
		// before installation is somebody else's.
		if (installed) {
			install.call(session, null);
		}
	}
}

/**
 * The granted stream reduced to its audio, with the video track stopped.
 *
 * Leaving the video track running holds the screen capture open for the whole
 * recording, which on Windows keeps the capture indicator up and costs frames
 * nobody reads.
 * @param granted - What getDisplayMedia answered with
 * @returns The same stream carrying audio alone
 */
function audioOnly(granted: MediaStream): MediaStream {
	for (const video of granted.getVideoTracks()) {
		video.stop();
		granted.removeTrack(video);
	}
	if (granted.getAudioTracks().length === 0) {
		throw new AudioStreamError(
			new Error(
				'The system output was not granted as audio. On Windows, check that ' +
					'screen capture is permitted; elsewhere, record a loopback input device.',
			),
		);
	}
	return granted;
}
