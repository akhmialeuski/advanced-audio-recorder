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
	/** Puts back the real process and removes the desktop require. */
	restore(): void;
}

/**
 * Installs a Windows host whose session exposes the display-media handler,
 * which is the one arrangement in which a system-audio grant is possible.
 * @returns The installed host, with its own teardown
 */
export function installDisplayMediaHost(): DisplayMediaHost {
	const handlers: (unknown | null)[] = [];
	const restorePlatform = usePlatform('win32');
	const restoreElectron = useElectron({
		remote: {
			getCurrentWebContents: () => ({
				session: {
					setDisplayMediaRequestHandler: (
						handler: unknown | null,
					): void => {
						handlers.push(handler);
					},
				},
			}),
		},
	});
	return {
		handlers,
		restore: (): void => {
			restoreElectron();
			restorePlatform();
		},
	};
}
