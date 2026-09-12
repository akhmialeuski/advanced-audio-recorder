/**
 * Standing in for the Electron host a system-audio capture asks for a grant.
 *
 * Two suites need the same arrangement: a platform Electron grants loopback
 * on, and a session exposing the display-media handler. Both are described
 * once here, because `process.platform` is read-only and has to be swapped
 * wholesale rather than assigned, which is the fiddly half.
 * @module tests/helpers/displayMediaHost
 */

/**
 * Points the runtime at one platform for the length of a test.
 *
 * Replaces the whole process object, which is what the diagnostics suite
 * does too: `platform` is read-only on the real one, so neither an
 * assignment nor jest.replaceProperty can move it.
 * @param platform - What process.platform should answer
 * @returns Puts the real process back
 */
export function usePlatform(platform: string): () => void {
	const real = process;
	Object.defineProperty(global, 'process', {
		value: { platform },
		configurable: true,
		writable: true,
	});
	return (): void => {
		Object.defineProperty(global, 'process', {
			value: real,
			configurable: true,
			writable: true,
		});
	};
}

/**
 * Exposes an electron module through the desktop `require` the plugin reads.
 * @param electron - What require('electron') should answer with
 * @returns Removes the require again
 */
export function useElectron(electron: unknown): () => void {
	Object.defineProperty(window, 'require', {
		value: () => electron,
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
	/** Puts back the real process and removes the desktop require. */
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
}

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
	const restorePlatform = usePlatform('win32');
	const restoreElectron = useElectron({
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
								Promise.resolve(sources),
						},
					}),
		},
	});
	return {
		handlers,
		sources,
		restore: (): void => {
			restoreElectron();
			restorePlatform();
		},
	};
}
