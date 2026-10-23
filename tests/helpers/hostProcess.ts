/**
 * Swapping the host process for one test, restored automatically.
 *
 * Three suites need a `process` other than the one the runner has: a Windows
 * platform or a recent enough Mac for the system-audio grant, a filled
 * `versions` object for the diagnostics report, and no process at all for the
 * mobile WebView. Each had written its own swap, and neither copy was
 * structural - both put the real process back on a line at the end of the
 * test body or of a local hook, so an assertion that failed first left every
 * later test on a fake platform.
 * With `--randomize` that is a different suite each run.
 *
 * `jest.replaceProperty` records the previous value and `restoreMocks: true`
 * puts it back after each test, exactly as {@link module:tests/helpers/platform}
 * does for Obsidian's `Platform`. It reaches `process` because the property
 * being replaced is `globalThis.process`, which is writable and configurable;
 * only `process.platform` on the real object is not, which is why the whole
 * object is swapped rather than one field of it.
 * @module tests/helpers/hostProcess
 */

import type { HostProcess } from 'src/platform/hostProcess';
import { globals } from './doubles';

/**
 * Runs the current test against this host process.
 * @param replacement - What the runtime should offer as `process`, or
 *   undefined for a runtime that declares none
 */
export function useHostProcess(replacement: HostProcess | undefined): void {
	jest.replaceProperty(globals(), 'process', replacement);
}

/**
 * Runs the current test on one platform, with nothing else on the process.
 * @param platform - What process.platform should answer
 */
export function usePlatform(platform: string): void {
	useHostProcess({ platform });
}

/** What a Mac reports about itself, as far as the system-audio grant asks. */
export interface MacHost {
	/** What process.getSystemVersion() answers, such as '14.2.1'. */
	readonly system?: string;
	/** What process.versions.electron answers, such as '39.0.0'. */
	readonly electron?: string;
}

/**
 * The lowest Mac Electron grants the system output on: macOS 14.2, where the
 * CoreAudio tap Chromium captures through first appears, in an installer
 * built on Electron 39, the first whose Chromium uses that tap by default.
 * At the floor rather than above it, so every case run on it also shows the
 * floor itself is accepted.
 */
export const MAC_GRANT_FLOOR = {
	system: '14.2',
	electron: '39.0.0',
} as const satisfies MacHost;

/**
 * Runs the current test on macOS, reporting the versions given and nothing
 * else. A version left out is not reported at all, which is how a host that
 * does not say it is tested.
 * @param mac - What the Mac reports
 */
export function useMacHost(mac: MacHost = MAC_GRANT_FLOOR): void {
	const { system, electron } = mac;
	useHostProcess({
		platform: 'darwin',
		...(electron === undefined ? {} : { versions: { electron } }),
		...(system === undefined ? {} : { getSystemVersion: () => system }),
	});
}

/**
 * Runs the current test on a runtime that declares no process, which is what
 * the mobile WebView offers: a name that is not declared at all, so reading
 * it without a `typeof` guard throws rather than answering undefined.
 */
export function withoutProcess(): void {
	useHostProcess(undefined);
}
