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
 * @throws Error whose message is the sentence the user reads, whether the
 *   refusal came before the request or from it. Plain, the way
 *   validateSelectedDevices refuses a session: {@link describeRecordingError}
 *   heads a plain Error with "Error starting recording:" and prints the rest
 *   of it unchanged, where an AudioStreamError would replace that head with
 *   "Failed to access audio device", naming a microphone for a track that has
 *   none and a capture that is not one.
 */
export async function captureSystemAudioStream(): Promise<MediaStream> {
	const host = loopbackHost();
	if ('refusal' in host) {
		throw new Error(host.refusal);
	}
	const { session, install, capturer } = host;
	let installed = false;
	try {
		const screen = await screenForGrant(capturer);
		install.call(session, (_request, callback) => {
			// The video source is required even though only audio is kept:
			// a request that asked for video and is granted none is refused
			// by Chromium as an invalid set of capture constraints.
			callback({ video: screen, audio: LOOPBACK_GRANT });
		});
		installed = true;
		return audioOnly(await grantedDisplayMedia());
	} finally {
		// Cleared only where this call installed something. Electron offers
		// no way to read the current handler back, and passing null resets
		// it to the default rather than to whatever was there, so a host
		// policy this plugin overwrote cannot be restored - all the guard
		// can do is not destroy one on a failure that never overwrote it.
		if (installed) {
			install.call(session, null);
		}
	}
}

/**
 * The screen a grant names as its video source.
 *
 * Listed before the request rather than from inside the handler, which
 * Electron documents as free to answer asynchronously and which its own
 * example does that way. Two things are bought by asking first, and neither
 * is available from inside the handler. A source list that fails, or comes
 * back empty, is said as a sentence about this machine; denied from the
 * handler it would reach the renderer as the bare `NotAllowedError` an empty
 * grant produces, indistinguishable from a user cancelling the share. And a
 * handler that never reaches its callback leaves `getDisplayMedia` pending
 * for good, which is what the documented example's own missing `catch` would
 * produce the first time the source list rejected.
 *
 * What that costs is one remote-module round trip inside the transient
 * activation `getDisplayMedia` requires and consumes. Screens alone, with no
 * thumbnails, is a read of the display list rather than a sweep of every
 * window, so the cost is milliseconds against a five-second budget.
 * @param capturer - Electron's desktopCapturer, as this host exposes it
 * @returns The screen the grant names as its video source
 * @throws Error saying why this machine has no source to name
 */
async function screenForGrant(
	capturer: DesktopCapturer,
): Promise<DesktopCapturerSource> {
	let offered: DesktopCapturerSource[];
	try {
		offered = await capturer.getSources({
			types: ['screen'],
			// No thumbnails: the frames would be captured, decoded and then
			// thrown away with the video track.
			thumbnailSize: { width: 0, height: 0 },
		});
	} catch (error) {
		// Finished here like every other refusal in this module. Left to
		// propagate, a failure of the remote module reached the notice as
		// whatever internal sentence it carries, alone and with nothing in
		// it a user could act on.
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`The screens this machine offers could not be listed: ${reason}. ` +
				'Record a loopback input device instead, such as Stereo Mix or ' +
				'VB-CABLE.',
		);
	}
	const [screen] = offered;
	if (!screen) {
		throw new Error(
			'This machine offered no screen to capture from, and the system ' +
				'output is granted alongside one. Record a loopback input ' +
				'device instead.',
		);
	}
	return screen;
}

/**
 * The display-media answer, with a refusal said in terms of what was refused.
 *
 * The request asked for the screen, so a refusal is about the screen-capture
 * permission. Neither of the two sentences a user would otherwise read says
 * that: `AudioStreamError` heads every failure with "Failed to access audio
 * device", and {@link describeRecordingError} reads a bare `NotAllowedError`
 * as a denied microphone and sends the user to the microphone permission,
 * which has no bearing on this. The message is therefore finished here and
 * thrown plain, which is the form describeRecordingError prints unchanged
 * after its own "Error starting recording:" head.
 * @returns What getDisplayMedia answered with, video track included
 * @throws Error saying why the system output was not granted
 */
async function grantedDisplayMedia(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getDisplayMedia({
			// Asked for and dropped by audioOnly: a request whose video is
			// false is rejected by the specification with a TypeError.
			video: true,
			audio: true,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'NotAllowedError') {
			throw new Error(
				"Permission to capture this computer's output was refused. " +
					'That is the screen-capture permission rather than the ' +
					'microphone one, so granting microphone access does not ' +
					'change it. Record a loopback input device instead, such as ' +
					'Stereo Mix or VB-CABLE.',
			);
		}
		// The specification makes getDisplayMedia consume a transient
		// activation, so it refuses a call that no user action led to and one
		// made from a window that is not focused. The plugin reaches it both
		// ways: the ribbon icon, the palette and a hotkey all carry an
		// activation, and the CLI `record` command carries none. Left to the
		// branch below, the sentence a user read was the internal wording of
		// that refusal followed by advice about virtual cables, which is not
		// what stopped them.
		if (
			error instanceof DOMException &&
			error.name === 'InvalidStateError'
		) {
			throw new Error(
				"Capturing this computer's output is granted only in answer " +
					'to a user action in a focused Obsidian window, so a ' +
					'session started from the command line, or while the ' +
					'window is in the background, cannot ask for it. Start ' +
					'the recording from Obsidian, or record a loopback input ' +
					'device, which a session started any way at all can use.',
			);
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`This computer's output could not be captured: ${reason}. ` +
				'Record a loopback input device instead, such as Stereo Mix or ' +
				'VB-CABLE.',
		);
	}
}

/**
 * The granted stream reduced to its audio, with the video track stopped.
 *
 * Leaving the video track running holds the screen capture open for the whole
 * recording, which on Windows keeps the capture indicator up and costs frames
 * nobody reads.
 *
 * Two things can be wrong with what is left afterwards, and the second is the
 * reason the first is no longer the only check. The specification lets a user
 * agent answer a request for audio with video alone, so there may be no audio
 * track at all. And Chromium ends a display capture through its video track,
 * while whether Electron's loopback audio hangs off that same capture is a
 * property of the build rather than something either API states: where it
 * does, the stop above hands back a stream whose only track is already dead,
 * and the session ends seconds in announcing a capture that stopped for no
 * reason the user can see. Named here where that ending is immediate; one
 * that arrives as an event instead is answered by
 * {@link module:recording/CaptureLossWatcher}, like the loss of any other
 * track.
 * @param granted - What getDisplayMedia answered with
 * @returns The same stream carrying audio alone
 * @throws Error saying why the answer carries no audio to record
 */
function audioOnly(granted: MediaStream): MediaStream {
	// Stopped before the answer is judged, not after: a video track nobody
	// goes on to stop holds the screen capture open for good, and every
	// refusal below leaves this stream with no owner to stop it later.
	for (const video of granted.getVideoTracks()) {
		video.stop();
		granted.removeTrack(video);
	}
	const [audio] = granted.getAudioTracks();
	if (!audio) {
		throw new Error(
			'The system output was not granted as audio. On Windows, check that ' +
				'screen capture is permitted; elsewhere, record a loopback input device.',
		);
	}
	// Compared against 'ended' rather than against 'live': a host that
	// reports no readyState at all is saying nothing about the track, and
	// nothing is not a reason to refuse a grant it has just made.
	if (audio.readyState === 'ended') {
		throw new Error(
			"This computer's output ended together with the screen capture it " +
				'was granted alongside, which this build holds open as one. ' +
				'Record a loopback input device instead, such as Stereo Mix or ' +
				'VB-CABLE.',
		);
	}
	return granted;
}
