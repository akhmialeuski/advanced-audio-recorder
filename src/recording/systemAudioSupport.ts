/**
 * Whether this host can hand the plugin the machine's own output as a stream.
 *
 * Obsidian registers no display-media request handler of its own, so a bare
 * `navigator.mediaDevices.getDisplayMedia` call fails here. A plugin may
 * register one for the length of a single request through Electron's remote
 * module, and Electron grants system audio on Windows, and on macOS 14.2 or
 * later from Electron 39 on, where Chromium takes it through Apple's CoreAudio
 * tap. Both halves of that answer are runtime facts about the installed build
 * and the machine rather than policy, which is why they are probed here and
 * not declared in {@link module:platform/capabilities}.
 *
 * The capture itself lives here too, because it is the same three facts read
 * twice: the handler, the platform, and the grant.
 * @module recording/systemAudioSupport
 */

import {
	hostProcess,
	hostSystemVersion,
	type HostProcess,
} from '../platform/hostProcess';
import { errorMessage } from '../errors';
import { isRefusal, valueOrThrow, type Refusable } from '../utils/refusal';

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

/** A platform Electron grants a system-audio loopback stream on. */
type GrantPlatform = 'win32' | 'darwin';

/** The grant that asks Electron for the machine's own output. */
const LOOPBACK_GRANT = 'loopback';

/** The leading two numbers of a version, which is all a floor compares. */
interface Version {
	readonly major: number;
	readonly minor: number;
}

/**
 * The first Electron whose Chromium grants the loopback on macOS. Chromium
 * made Apple's CoreAudio tap the default for it in Electron 39; before that
 * it sat behind feature switches an app sets at launch, which Obsidian does
 * not, so on an older build a grant is nothing the plugin can count on.
 */
const MAC_LOOPBACK_ELECTRON: Version = { major: 39, minor: 0 };

/** The first macOS offering the CoreAudio tap Chromium captures through. */
const MAC_LOOPBACK_SYSTEM: Version = { major: 14, minor: 2 };

/** What a Windows user records instead where the direct capture fails. */
const WINDOWS_LOOPBACK_INPUT =
	'Record a loopback input device instead, such as Stereo Mix or VB-CABLE.';

/** What a macOS user records instead where the direct capture fails. */
const MAC_LOOPBACK_INPUT =
	'Record a loopback input device instead, such as BlackHole.';

/**
 * Where macOS keeps the permission a capture of its output needs, and what
 * it takes for a change there to reach a running app. The pane is called
 * Screen & System Audio Recording from macOS 15 and Screen Recording before
 * it, and macOS reads the answer when an app starts rather than while it
 * runs, which is why the restart is part of the step. Obsidian may be
 * missing from that list: Electron raises no macOS prompt for a source the
 * app picks itself rather than through the system picker
 * (electron/electron#52738), so the step says how to add it by hand.
 */
const MAC_PERMISSION_STEP =
	'Allow Obsidian under System Settings > Privacy & Security > Screen & ' +
	'System Audio Recording (Screen Recording on macOS 14), adding it with ' +
	'the + button if it is not listed, then quit and reopen Obsidian.';

/** The way out a macOS refusal offers after the permission step. */
const MAC_PERMISSION_FALLBACK =
	'Or record a loopback input device instead, such as BlackHole.';

/** Everything a display-media grant needs from the host, once all of it is found. */
interface LoopbackHost {
	/** The platform granting it, which decides what a failure tells the user. */
	readonly platform: GrantPlatform;
	/** The session the handler is installed on and taken back off. */
	readonly session: DisplayMediaSession;
	/** The handler slot, read off the session so it can be called on it. */
	readonly install: InstallDisplayMediaHandler;
	/** The source list the grant's video half is named from. */
	readonly capturer: DesktopCapturer;
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
 * The leading major and minor numbers of a version string, or null where it
 * does not start with one. Electron's own versions carry a pre-release tail,
 * as in '39.0.0-beta.4', and macOS reports two or three parts, so only the
 * first two numbers are read and a missing minor counts as zero.
 * @param text - The version as the host reports it
 * @returns The parsed version, or null for a string carrying none
 */
function leadingVersion(text: string | undefined): Version | null {
	const match = /^(\d+)(?:\.(\d+))?/.exec(text ?? '');
	if (!match?.[1]) {
		return null;
	}
	return { major: Number(match[1]), minor: Number(match[2] ?? '0') };
}

/**
 * Whether a version is at or above a floor.
 * @param version - The version to judge
 * @param floor - The lowest version that passes
 * @returns True when the version reaches the floor
 */
function reaches(version: Version, floor: Version): boolean {
	return version.major === floor.major
		? version.minor >= floor.minor
		: version.major > floor.major;
}

/**
 * Why this Mac cannot be granted its own output, or null where it can.
 *
 * Both floors are checked before the host is asked, for the reason the
 * platform check is: asked anyway, a Mac below them answers with an audio
 * track that never carries a sample, after the screen-recording prompt, so a
 * user who chose the system output would grant a permission and then record
 * silence. A version the host does not report counts as below the floor,
 * since nothing about such a host says the capture would work.
 *
 * The macOS floor is checked first because it is the one no Obsidian update
 * can lift. The Electron floor names the installer rather than Obsidian
 * itself, because Electron is updated only by running a new installer, and an
 * install kept current by Obsidian's own updates can still run an old one.
 * @param proc - The host process, already known to be macOS
 * @returns The sentence the user reads, or null
 */
function macRefusal(proc: HostProcess): string | null {
	const system = hostSystemVersion(proc);
	const parsedSystem = leadingVersion(system);
	if (!parsedSystem || !reaches(parsedSystem, MAC_LOOPBACK_SYSTEM)) {
		const running =
			system === undefined
				? 'a macOS that does not report its version'
				: `macOS ${system}`;
		return (
			'Recording the system output directly needs macOS 14.2 or later, ' +
			`and this Mac runs ${running}. ${MAC_LOOPBACK_INPUT}`
		);
	}
	const electron = proc.versions?.electron;
	const parsedElectron = leadingVersion(electron);
	if (!parsedElectron || !reaches(parsedElectron, MAC_LOOPBACK_ELECTRON)) {
		const running =
			electron === undefined || electron === ''
				? 'an Electron that does not report its version'
				: `Electron ${electron}`;
		return (
			'Recording the system output directly on macOS needs an Obsidian ' +
			`installer built on Electron 39 or later, and this one runs ${running}. ` +
			'Download and run the current installer from obsidian.md, since ' +
			`Obsidian's own updates do not replace it. ${MAC_LOOPBACK_INPUT}`
		);
	}
	return null;
}

/**
 * The platform a grant would be asked on, or why this one grants none.
 * @returns The platform, or the sentence the user reads
 */
function grantPlatform(): Refusable<GrantPlatform> {
	const proc = hostProcess();
	if (proc?.platform === 'win32') {
		return { value: 'win32' };
	}
	if (proc?.platform === 'darwin') {
		const refusal = macRefusal(proc);
		return refusal === null ? { value: 'darwin' } : { refusal };
	}
	return {
		refusal:
			'Recording the system output directly is granted on Windows and on ' +
			'macOS only. Record a loopback input device instead, such as a ' +
			'PipeWire monitor.',
	};
}

/**
 * What a user records instead, said for the platform the grant failed on.
 * @param platform - The platform the grant was asked on
 * @returns The sentence closing the refusal
 */
function loopbackInputAdvice(platform: GrantPlatform): string {
	return platform === 'darwin' ? MAC_LOOPBACK_INPUT : WINDOWS_LOOPBACK_INPUT;
}

/**
 * What a grant needs from this host, or the sentence saying why it cannot be
 * had here.
 *
 * Three facts decide it, and both callers need the same three: the platform,
 * because Electron offers the loopback grant on Windows and on a recent
 * enough macOS alone; the handler, because Obsidian installs none of its own;
 * and the source list, because a grant names a video source even when only
 * audio is wanted, so a host that answers the handler and hides the capturer
 * cannot complete a request. Answered once here so the report and the capture
 * can never disagree about what this build can do, and so the refusal a user
 * reads is the reason that actually stopped it.
 * @returns The three halves of a grant, or the reason there are not three
 */
function loopbackHost(): Refusable<LoopbackHost> {
	const platform = grantPlatform();
	if (isRefusal(platform)) {
		return platform;
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
	return { value: { platform: platform.value, session, install, capturer } };
}

/** What this build and platform answer about granting the system output. */
export interface SystemAudioGrantSupport {
	/**
	 * Why a grant cannot be had here, in the words a refused recording
	 * would use, or null where it can.
	 */
	readonly refusal: string | null;
	/**
	 * What the platform asks the user to allow before it hands the output
	 * over, or null where it asks nothing. Said where the grant is
	 * available, because that is where a user is about to need it.
	 */
	readonly permission: string | null;
}

/**
 * Whether a system-audio stream can be granted on this build and platform,
 * and what a user has to know about it either way.
 *
 * Said on the settings rows that offer the system output and in the System
 * info snapshot, so a user can see what their install is capable of, and
 * why, without being walked through a developer console. The refusal is the
 * very sentence a recording started anyway would end with.
 * @returns The answer, read once from the host
 */
export function systemAudioGrantSupport(): SystemAudioGrantSupport {
	const host = loopbackHost();
	if (isRefusal(host)) {
		return { refusal: host.refusal, permission: null };
	}
	return {
		refusal: null,
		permission:
			host.value.platform === 'darwin'
				? `macOS hands its output only to an app allowed to record it. ${MAC_PERMISSION_STEP}`
				: null,
	};
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
 * - Electron grants system audio through `audio: 'loopback'` on Windows and
 *   on a recent enough macOS alone, which is why {@link loopbackHost} is
 *   asked first and its refusal thrown as it stands.
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
	const { platform, session, install, capturer } =
		valueOrThrow(loopbackHost());
	let installed = false;
	try {
		const screen = await screenForGrant(capturer, platform);
		install.call(session, (_request, callback) => {
			// The video source is required even though only audio is kept:
			// a request that asked for video and is granted none is refused
			// by Chromium as an invalid set of capture constraints.
			callback({ video: screen, audio: LOOPBACK_GRANT });
		});
		installed = true;
		return audioOnly(await grantedDisplayMedia(platform), platform);
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
 *
 * On macOS the list is the first thing the screen-recording permission
 * gates: without it Electron rejects the call with "Failed to get sources",
 * and a build that does not reject it can answer with no screen at all
 * instead. Either way the permission is what a user can change, so it is what
 * the refusal names.
 * @param capturer - Electron's desktopCapturer, as this host exposes it
 * @param platform - The platform the grant is asked on
 * @returns The screen the grant names as its video source
 * @throws Error saying why this machine has no source to name
 */
async function screenForGrant(
	capturer: DesktopCapturer,
	platform: GrantPlatform,
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
		const reason = errorMessage(error);
		const listed = `The screens this machine offers could not be listed: ${reason}.`;
		throw new Error(
			platform === 'darwin'
				? `${listed} macOS lists them only to an app allowed to record ` +
						`the screen. ${MAC_PERMISSION_STEP} ${MAC_PERMISSION_FALLBACK}`
				: `${listed} ${WINDOWS_LOOPBACK_INPUT}`,
		);
	}
	const [screen] = offered;
	if (!screen) {
		const none =
			'This machine offered no screen to capture from, and the system ' +
			'output is granted alongside one.';
		throw new Error(
			platform === 'darwin'
				? `${none} ${MAC_PERMISSION_STEP} ${MAC_PERMISSION_FALLBACK}`
				: `${none} Record a loopback input device instead.`,
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
 * @param platform - The platform the grant is asked on, which decides the
 *   permission a refusal sends the user to
 * @returns What getDisplayMedia answered with, video track included
 * @throws Error saying why the system output was not granted
 */
async function grantedDisplayMedia(
	platform: GrantPlatform,
): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getDisplayMedia({
			// Asked for and dropped by audioOnly: a request whose video is
			// false is rejected by the specification with a TypeError.
			video: true,
			audio: true,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'NotAllowedError') {
			const refused =
				"Permission to capture this computer's output was refused.";
			throw new Error(
				platform === 'darwin'
					? `${refused} That is the screen and system audio ` +
							'recording permission rather than the microphone ' +
							'one, so granting microphone access does not change ' +
							`it. ${MAC_PERMISSION_STEP} ${MAC_PERMISSION_FALLBACK}`
					: `${refused} That is the screen-capture permission ` +
							'rather than the microphone one, so granting ' +
							'microphone access does not change it. ' +
							WINDOWS_LOOPBACK_INPUT,
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
		const reason = errorMessage(error);
		throw new Error(
			`This computer's output could not be captured: ${reason}. ` +
				loopbackInputAdvice(platform),
		);
	}
}

/**
 * The granted stream reduced to its audio, with the video track stopped.
 *
 * Leaving the video track running holds the screen capture open for the whole
 * recording, which keeps the operating system's capture indicator up and
 * costs frames nobody reads.
 *
 * Three things can be wrong with what is left afterwards. The specification
 * lets a user agent answer a request for audio with video alone, so there may
 * be no audio track at all. On macOS a grant made without the System Audio
 * Recording permission still carries an audio track, created already ended
 * and never delivering a sample, with no error raised anywhere; that is the
 * one sign of the missing permission a renderer gets, so it is read before
 * the video is touched and named as the permission. And Chromium ends a
 * display capture through its video track, while whether Electron's loopback
 * audio hangs off that same capture is a property of the build rather than
 * something either API states: where it does, the stop below hands back a
 * stream whose only track is already dead, and the session ends seconds in
 * announcing a capture that stopped for no reason the user can see. Named
 * here where that ending is immediate; one that arrives as an event instead
 * is answered by {@link module:recording/CaptureLossWatcher}, like the loss
 * of any other track.
 * @param granted - What getDisplayMedia answered with
 * @param platform - The platform the grant was asked on, which decides what
 *   a refusal tells the user to do
 * @returns The same stream carrying audio alone
 * @throws Error saying why the answer carries no audio to record
 */
function audioOnly(granted: MediaStream, platform: GrantPlatform): MediaStream {
	// Compared against 'ended' rather than against 'live', here and below: a
	// host that reports no readyState at all is saying nothing about the
	// track, and nothing is not a reason to refuse a grant it has just made.
	// Read before the video is stopped, so a track that arrived dead is told
	// apart from one the stop took down with it.
	const endedOnArrival = granted.getAudioTracks()[0]?.readyState === 'ended';
	// Stopped before the answer is judged, not after: a video track nobody
	// goes on to stop holds the screen capture open for good, and every
	// refusal below leaves this stream with no owner to stop it later.
	for (const video of granted.getVideoTracks()) {
		video.stop();
		granted.removeTrack(video);
	}
	const [audio] = granted.getAudioTracks();
	if (!audio) {
		const missing = 'The system output was not granted as audio.';
		throw new Error(
			platform === 'darwin'
				? `${missing} ${MAC_PERMISSION_STEP} ${MAC_PERMISSION_FALLBACK}`
				: `${missing} Check that screen capture is permitted. ` +
						WINDOWS_LOOPBACK_INPUT,
		);
	}
	if (endedOnArrival) {
		throw new Error(
			platform === 'darwin'
				? "macOS handed this computer's output over as a track that " +
						'had already ended, which is what it does when Obsidian ' +
						'is not allowed to record system audio. ' +
						`${MAC_PERMISSION_STEP} ${MAC_PERMISSION_FALLBACK}`
				: "This computer's output was granted as a track that had " +
						'already ended, so there is nothing to record from it. ' +
						WINDOWS_LOOPBACK_INPUT,
		);
	}
	if (audio.readyState === 'ended') {
		throw new Error(
			"This computer's output ended together with the screen capture it " +
				'was granted alongside, which this build holds open as one. ' +
				loopbackInputAdvice(platform),
		);
	}
	return granted;
}
