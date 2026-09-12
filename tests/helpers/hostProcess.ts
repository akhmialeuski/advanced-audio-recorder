/**
 * Swapping the host process for one test, restored automatically.
 *
 * Three suites need a `process` other than the one the runner has: a Windows
 * platform for the system-audio grant, a filled `versions` object for the
 * diagnostics report, and no process at all for the mobile WebView. Each had
 * written its own swap, and neither copy was structural - both put the real
 * process back on a line at the end of the test body or of a local hook, so
 * an assertion that failed first left every later test on a fake platform.
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

/**
 * Runs the current test on a runtime that declares no process, which is what
 * the mobile WebView offers: a name that is not declared at all, so reading
 * it without a `typeof` guard throws rather than answering undefined.
 */
export function withoutProcess(): void {
	useHostProcess(undefined);
}
