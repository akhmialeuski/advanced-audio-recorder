/**
 * The one place that reads Node's `process` off the host.
 *
 * The same bundle runs on the desktop, where Electron declares `process`, and
 * in the mobile WebView, where nothing declares it at all. Optional chaining
 * does not cover that difference: `process?.platform` still evaluates the
 * identifier, and an identifier nothing declared throws a `ReferenceError`
 * before the `?.` is reached. Only `typeof` is safe on a name that may be
 * absent, so every read of the host process goes through here rather than
 * being written out again at each call site, where one copy can forget it.
 * @module platform/hostProcess
 */

/**
 * What the plugin reads off the host process. Every field is optional: this
 * describes what a renderer may find, not what Node guarantees.
 */
export interface HostProcess {
	/** Runtime versions, as Electron fills them in. */
	readonly versions?: {
		readonly electron?: string;
		readonly node?: string;
		readonly chrome?: string;
	};
	/** The operating system, in Node's spelling ('win32', 'darwin', 'linux'). */
	readonly platform?: string;
	/** The CPU architecture, in Node's spelling. */
	readonly arch?: string;
}

/**
 * The host process, or null on a runtime that declares none.
 *
 * Null is a real answer rather than a failure: the mobile WebView has a
 * navigator and no process, and a test environment may have neither.
 * @returns The process, or null where there is none to read
 */
export function hostProcess(): HostProcess | null {
	// Widened by the return type rather than by a cast: Node's own process is
	// assignable to the narrow shape read here, so naming that shape is all
	// the narrowing this needs.
	return typeof process !== 'undefined' ? process : null;
}
