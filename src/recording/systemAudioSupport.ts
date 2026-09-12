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
import { hostProcess } from '../platform/hostProcess';

/** One grant handed back to a display-media request. */
interface DisplayMediaGrant {
	video?: unknown;
	audio?: string;
}

/** What Electron calls to ask who may capture what. */
type DisplayMediaRequestHandler = (
	request: unknown,
	callback: (streams: DisplayMediaGrant) => void,
) => void;

/** The part of an Electron session this plugin reaches for. */
interface DisplayMediaSession {
	setDisplayMediaRequestHandler?: (
		handler: DisplayMediaRequestHandler | null,
		options?: { useSystemPicker: boolean },
	) => void;
}

/** Installs, or takes back down, the handler for one display-media request. */
type InstallDisplayMediaHandler = NonNullable<
	DisplayMediaSession['setDisplayMediaRequestHandler']
>;

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

/** Everything a display-media grant needs from the host, once all of it is found. */
interface LoopbackHost {
	/** The session the handler is installed on and taken back off. */
	readonly session: DisplayMediaSession;
	/** The handler slot, read off the session so it can be called on it. */
	readonly install: InstallDisplayMediaHandler;
	/** The source list the grant's video half is named from. */
	readonly capturer: DesktopCapturer;
}

/** Why the system output cannot be granted here, in the user's words. */
interface LoopbackRefusal {
	readonly refusal: string;
}

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
 * What a grant needs from this host, or the sentence saying why it cannot be
 * had here.
 *
 * Three facts decide it, and both callers need the same three: the platform,
 * because Electron offers the loopback grant on Windows alone; the handler,
 * because Obsidian installs none of its own; and the source list, because a
 * grant names a video source even when only audio is wanted, so a host that
 * answers the handler and hides the capturer cannot complete a request.
 * Answered once here so the report and the capture can never disagree about
 * what this build can do, and so the refusal a user reads is the reason that
 * actually stopped it.
 * @returns The three halves of a grant, or the reason there are not three
 */
function loopbackHost(): LoopbackHost | LoopbackRefusal {
	if (hostProcess()?.platform !== LOOPBACK_GRANT_PLATFORM) {
		return {
			refusal:
				'Recording the system output directly is granted on Windows only. ' +
				'Record a loopback input device instead, such as Stereo Mix, ' +
				'VB-CABLE or a PipeWire monitor.',
		};
	}
	const session = currentElectronSession();
	const install = session?.setDisplayMediaRequestHandler;
	if (!session || !install) {
		return {
			refusal:
				'This Obsidian build exposes no way to capture the system output. ' +
				'Record a loopback input device instead.',
		};
	}
	const capturer = desktopCapturer();
	if (!capturer) {
		return {
			refusal:
				'This Obsidian build exposes no screen source list, which a system ' +
				'audio grant needs. Record a loopback input device instead.',
		};
	}
	return { session, install, capturer };
}

/**
 * Whether a system-audio stream can be granted on this build and platform.
 *
 * Reported in the System info snapshot so a user can say what their install
 * is capable of without being walked through a developer console.
 * @returns True when a grant has everything it needs here
 */
export function isSystemAudioLoopbackAvailable(): boolean {
	return !('refusal' in loopbackHost());
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
 *   alone, which is why {@link loopbackHost} is asked first and its refusal
 *   thrown as it stands.
 *
 * That refusal comes before any host call on purpose. Asking anyway on a
 * platform without the grant would raise the operating system's own
 * screen-share prompt, and answer it with a stream carrying no audio: a user
 * who chose the system output would be shown a screen picker and then told
 * their screen had no sound in it.
 *
 * The handler is installed for the length of this one request and taken back
 * down in `finally`, so the plugin never leaves the host application with a
 * display-media policy of its own.
 * @returns A stream carrying one audio track of the system output
 * @throws AudioStreamError when the host, the platform, or the answer cannot
 *   provide one
 */
export async function captureSystemAudioStream(): Promise<MediaStream> {
	const host = loopbackHost();
	if ('refusal' in host) {
		throw new AudioStreamError(new Error(host.refusal));
	}
	const { session, install, capturer } = host;
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
