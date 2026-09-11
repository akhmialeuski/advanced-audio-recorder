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
 * This module answers the question only. The capture that acts on the answer
 * belongs to the source that performs it.
 * @module recording/systemAudioSupport
 */

/** The part of an Electron session this plugin would reach for. */
interface DisplayMediaSession {
	setDisplayMediaRequestHandler?: unknown;
}

/** The part of Electron's remote module this plugin would reach for. */
interface ElectronRemote {
	getCurrentWebContents?: () => { session?: DisplayMediaSession } | undefined;
}

/** Platform Electron grants a system-audio loopback stream on. */
const LOOPBACK_GRANT_PLATFORM = 'win32';

/**
 * The Electron session this window runs in, or null where the host exposes
 * no way to reach it. Read through the same desktop `require` the local
 * transcription engine uses, so a mobile build (which has none) answers null
 * rather than throwing.
 * @returns The session, or null
 */
function currentElectronSession(): DisplayMediaSession | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		const remote = (req('electron') as { remote?: ElectronRemote }).remote;
		return remote?.getCurrentWebContents?.()?.session ?? null;
	} catch {
		// A host without the remote module, or one that refuses the lookup.
		return null;
	}
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
	return typeof session?.setDisplayMediaRequestHandler === 'function';
}
