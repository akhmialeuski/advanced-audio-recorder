/**
 * Standing in for the Electron host a system-audio capture asks for a grant.
 *
 * Two suites need the same arrangement: a platform Electron grants loopback
 * on, and a session exposing the display-media handler. The platform half is
 * {@link module:tests/helpers/hostProcess}, which every suite that swaps the
 * process shares; what is described here is the electron module reached
 * through the desktop `require`.
 * @module tests/helpers/displayMediaHost
 */

import { usePlatform } from './hostProcess';

/**
 * Exposes an electron module through the desktop `require` the plugin reads.
 *
 * Removed by the returned teardown rather than by `jest.replaceProperty`:
 * `require` is not a property of the test global at all, and replaceProperty
 * only replaces one that already exists. A leaked one is inert anyway, since
 * the platform it would be read on is restored structurally.
 * @param electron - What require('electron') should answer with
 * @param onRequire - Called on every lookup, for a test that cares how many
 *   times the code under test reached for the host
 * @returns Removes the require again
 */
export function useElectron(
	electron: unknown,
	onRequire: () => void = () => undefined,
): () => void {
	Object.defineProperty(window, 'require', {
		value: () => {
			onRequire();
			return electron;
		},
		configurable: true,
		writable: true,
	});
	return (): void => {
		Reflect.deleteProperty(window, 'require');
	};
}

/** A host that can grant the system output, and its teardown. */
export interface DisplayMediaHost {
	/** The handlers the code under test installed, newest last. */
	readonly handlers: (unknown | null)[];
	/** The screen sources the host offers, as desktopCapturer answers. */
	readonly sources: { id: string; name: string }[];
	/**
	 * How many times the code under test reached for the electron module.
	 *
	 * Every read of the host costs a trip through the remote module on a
	 * real install, so a caller asking once per row of a settings page
	 * rather than once for the page is a defect the count can name.
	 * @returns Calls to the desktop require so far
	 */
	probeCount(): number;
	/** Removes the desktop require; the platform restores itself. */
	restore(): void;
}

/** How much of a granting host a test wants to be missing. */
export interface DisplayMediaHostOptions {
	/** Leave the session without a display-media handler. */
	readonly withoutHandler?: boolean;
	/** Leave the remote module without a desktopCapturer. */
	readonly withoutCapturer?: boolean;
	/** Answer the source list with nothing. */
	readonly withoutScreens?: boolean;
	/**
	 * Refuse the source list outright, with this as the reason. A remote
	 * module that answers the lookup and then fails the call is the one host
	 * failure that reaches the capture as an error rather than as an absence.
	 */
	readonly sourceListFailure?: string;
	/**
	 * Run the host on this platform instead of the one Electron grants the
	 * loopback on. Swapped here rather than by a second call, so a test
	 * never states the platform twice and has them disagree.
	 */
	readonly platform?: string;
}

/** Platform Electron grants a system-audio loopback stream on. */
const LOOPBACK_GRANT_PLATFORM = 'win32';

/**
 * Installs a Windows host that can grant the system output.
 *
 * Both halves are here because a grant needs both: the handler answers the
 * request, and desktopCapturer supplies the video source the request is
 * refused without. Each can be left out, which is how the refusals are
 * tested.
 * @param options - Which half to leave missing
 * @returns The installed host, with its own teardown
 */
export function installDisplayMediaHost(
	options: DisplayMediaHostOptions = {},
): DisplayMediaHost {
	const handlers: (unknown | null)[] = [];
	const sources = options.withoutScreens
		? []
		: [{ id: 'screen:0:0', name: 'Entire screen' }];
	let probes = 0;
	usePlatform(options.platform ?? LOOPBACK_GRANT_PLATFORM);
	const restoreElectron = useElectron(
		{
			remote: {
				getCurrentWebContents: () => ({
					session: options.withoutHandler
						? {}
						: {
								setDisplayMediaRequestHandler: (
									handler: unknown | null,
								): void => {
									handlers.push(handler);
								},
							},
				}),
				...(options.withoutCapturer
					? {}
					: {
							desktopCapturer: {
								getSources: (): Promise<typeof sources> =>
									options.sourceListFailure === undefined
										? Promise.resolve(sources)
										: Promise.reject(
												new Error(
													options.sourceListFailure,
												),
											),
							},
						}),
			},
		},
		() => {
			probes += 1;
		},
	);
	return {
		handlers,
		sources,
		probeCount: (): number => probes,
		restore: restoreElectron,
	};
}
