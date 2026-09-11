/**
 * Unit tests for the system-audio availability probe.
 * @module tests/unit/systemAudioSupport.test
 */

import { isSystemAudioLoopbackAvailable } from 'src/recording/systemAudioSupport';

/** Installs a desktop `require` answering with the given electron module. */
function withElectron(electron: unknown): void {
	Object.defineProperty(window, 'require', {
		value: (id: string) => {
			if (id !== 'electron') {
				throw new Error(`unexpected require of ${id}`);
			}
			return electron;
		},
		configurable: true,
		writable: true,
	});
}

/** An electron module whose session exposes the display-media handler. */
function electronWithHandler(): unknown {
	return {
		remote: {
			getCurrentWebContents: () => ({
				session: { setDisplayMediaRequestHandler: (): void => {} },
			}),
		},
	};
}

describe('isSystemAudioLoopbackAvailable', () => {
	const realProcess = process;

	afterEach(() => {
		Reflect.deleteProperty(window, 'require');
		Object.defineProperty(global, 'process', {
			value: realProcess,
			configurable: true,
			writable: true,
		});
	});

	/**
	 * Points the runtime at one platform. Replaces the whole process object
	 * the way the diagnostics suite does, because `platform` is read-only on
	 * the real one.
	 * @param platform - What process.platform should answer
	 */
	function onPlatform(platform: string): void {
		Object.defineProperty(global, 'process', {
			value: { platform },
			configurable: true,
			writable: true,
		});
	}

	it('reports the grant on a Windows build that exposes the handler', () => {
		onPlatform('win32');
		withElectron(electronWithHandler());

		expect(isSystemAudioLoopbackAvailable()).toBe(true);
	});

	// Electron documents the loopback grant as Windows-only, so the other
	// platforms are refused before the host is even asked.
	it.each([{ platform: 'darwin' }, { platform: 'linux' }])(
		'refuses the grant on $platform',
		({ platform }) => {
			onPlatform(platform);
			withElectron(electronWithHandler());

			expect(isSystemAudioLoopbackAvailable()).toBe(false);
		},
	);

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
				withElectron({});
			},
		},
		{
			absent: 'a display-media handler on the session',
			install: (): void => {
				withElectron({
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
				Object.defineProperty(window, 'require', {
					value: (): never => {
						throw new Error('blocked');
					},
					configurable: true,
					writable: true,
				});
			},
		},
	])('refuses the grant on Windows without $absent', ({ install }) => {
		onPlatform('win32');
		install();

		expect(isSystemAudioLoopbackAvailable()).toBe(false);
	});
});
