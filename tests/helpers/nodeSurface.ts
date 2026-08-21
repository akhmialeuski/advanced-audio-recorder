/**
 * The Node surface Obsidian exposes on the desktop, faked for a test.
 *
 * `window.require` is the only way a plugin reaches `child_process` and `fs`,
 * and it exists on the desktop app and nowhere else. Two things need it: the
 * whisper.cpp provider, which shells out through it, and the engine registry,
 * which refuses to build that provider when it is absent. Both used to be
 * stuck with whatever the ambient jsdom window happened to have.
 *
 * Installing it is shared state, so the handle carries its own `restore()`
 * rather than leaving each suite to remember a `delete window.require` - the
 * reset §8 of docs/dev/testing.md asks for, structural instead of conventional.
 * @module tests/helpers/nodeSurface
 */

/** How the faked binary and filesystem should behave on this run. */
export interface NodeSurfaceBehaviour {
	/** Error handed to the execFile callback, for a binary that fails. */
	execError?: Error;
	/** Output file contents, or a thrower for a binary that wrote none. */
	output?: string | (() => never);
	/**
	 * Makes `window.require` itself throw, the way it does when the desktop
	 * modules are not reachable.
	 */
	noRequire?: boolean;
}

/** One `execFile` call the code under test made. */
export interface NodeInvocation {
	/** The executable it asked for. */
	file: string;
	/** The arguments it passed, in order. */
	args: string[];
}

/** An installed Node surface, and what the code under test did with it. */
export interface NodeSurface {
	/** Paths written before the binary was invoked, in order. */
	written: string[];
	/** Paths removed on the way out, in order. */
	removed: string[];
	/** Binary invocations, in order. */
	invocations: NodeInvocation[];
	/** The arguments of the most recent invocation, empty when there was none. */
	lastArgs: () => string[];
	/** Puts `window.require` back the way it was found. */
	restore: () => void;
}

/** The window as the desktop app hands it over. */
interface RequireWindow {
	require?: (id: string) => unknown;
}

/** The default whisper.cpp JSON, for a run that does not script its own. */
const DEFAULT_OUTPUT = JSON.stringify({
	language: 'en',
	transcription: [{ offsets: { from: 0, to: 1000 }, text: 'hi' }],
});

/**
 * Installs a fake `window.require` for the current test.
 * @param behaviour - How the faked binary and filesystem should behave
 * @returns The surface, with a `restore()` the caller runs in afterEach
 */
export function installNodeSurface(
	behaviour: NodeSurfaceBehaviour = {},
): NodeSurface {
	const original = Object.getOwnPropertyDescriptor(window, 'require');
	const surface: NodeSurface = {
		written: [],
		removed: [],
		invocations: [],
		lastArgs: () => surface.invocations.at(-1)?.args ?? [],
		restore: () => {
			if (original) {
				Object.defineProperty(window, 'require', original);
			} else {
				delete (window as RequireWindow).require;
			}
		},
	};

	if (behaviour.noRequire) {
		(window as RequireWindow).require = (): never => {
			throw new Error('require is not available here');
		};
		return surface;
	}

	const modules: Record<string, unknown> = {
		child_process: {
			execFile: (
				file: string,
				args: string[],
				_options: unknown,
				callback: (
					error: Error | null,
					stdout: string,
					stderr: string,
				) => void,
			): void => {
				surface.invocations.push({ file, args });
				callback(behaviour.execError ?? null, '', '');
			},
		},
		fs: {
			writeFileSync: (path: string): void => {
				surface.written.push(path);
			},
			readFileSync: (): string => {
				const output = behaviour.output;
				return typeof output === 'function'
					? output()
					: (output ?? DEFAULT_OUTPUT);
			},
			rmSync: (path: string): void => {
				surface.removed.push(path);
			},
		},
		os: { tmpdir: (): string => '/tmp' },
		path: { join: (...parts: string[]): string => parts.join('/') },
	};
	(window as RequireWindow).require = (id: string): unknown => modules[id];
	return surface;
}
