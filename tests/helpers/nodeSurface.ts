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
	/** What the binary writes to its output file. */
	output?: string;
	/**
	 * Makes the binary produce no output file at all - the case a wrong flag
	 * or a crashed run leaves behind.
	 */
	writesNoOutput?: boolean;
	/**
	 * Makes `window.require` itself throw, the way it does when the desktop
	 * modules are not reachable.
	 */
	noRequire?: boolean;
	/**
	 * Makes the binary run until Node stops it, the way a hung one does.
	 *
	 * The callback then fires only on what execFile was given to stop it with:
	 * the abort signal, or the timeout. Node marks a process it killed with
	 * `killed`, and that is what the caller reads to tell a run that ran out of
	 * time from a binary that simply failed.
	 */
	neverSettles?: boolean;
}

/** How a child process was bounded and cancelled, as the caller asked. */
export interface NodeInvocationOptions {
	maxBuffer: number;
	timeout?: number;
	signal?: AbortSignal;
}

/** One `execFile` call the code under test made. */
export interface NodeInvocation {
	/** The executable it asked for. */
	file: string;
	/** The arguments it passed, in order. */
	args: string[];
	/**
	 * What it asked Node to bound the run with. The kill itself is Node's, so
	 * these options are what a test can hold it to.
	 */
	options: NodeInvocationOptions;
}

/** An installed Node surface, and what the code under test did with it. */
export interface NodeSurface {
	/** The fake filesystem, keyed by the path each write was made to. */
	files: Map<string, string>;
	/** Paths written before the binary was invoked, in order. */
	written: string[];
	/** Paths removed on the way out, in order. */
	removed: string[];
	/** Binary invocations, in order. */
	invocations: NodeInvocation[];
	/** The arguments of the most recent invocation, empty when there was none. */
	lastArgs: () => string[];
	/** The options of the most recent invocation, or undefined when there was none. */
	lastOptions: () => NodeInvocationOptions | undefined;
	/** Puts `window.require` back the way it was found. */
	restore: () => void;
}

/** The window as the desktop app hands it over. */
interface RequireWindow {
	require?: (id: string) => unknown;
}

/**
 * The error Node hands back for a child it killed itself, which is how both a
 * timeout and an abort arrive: the `killed` marker is the only thing that
 * separates them from a binary that exited with a status of its own.
 * @param name - Error name Node uses for this ending
 * @returns The error to hand the callback
 */
function killedError(name: string): Error {
	const error = new Error('Command failed');
	error.name = name;
	return Object.assign(error, { killed: true });
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
	const files = new Map<string, string>();
	const surface: NodeSurface = {
		files,
		written: [],
		removed: [],
		invocations: [],
		lastArgs: () => surface.invocations.at(-1)?.args ?? [],
		lastOptions: () => surface.invocations.at(-1)?.options,
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
				options: NodeInvocationOptions,
				callback: (
					error: Error | null,
					stdout: string,
					stderr: string,
				) => void,
			): void => {
				surface.invocations.push({ file, args, options });
				if (behaviour.neverSettles) {
					// Nothing is written and nothing answers until whatever
					// execFile was given to stop the run with does, which is
					// exactly the shape of a binary that hangs.
					options.signal?.addEventListener('abort', () => {
						callback(killedError('AbortError'), '', '');
					});
					if (options.timeout !== undefined) {
						setTimeout(() => {
							callback(killedError('Error'), '', '');
						}, options.timeout);
					}
					return;
				}
				// whisper.cpp writes its JSON next to the base name given by
				// -of. Honouring that is what makes the caller's -of / read
				// pairing falsifiable: a run that reads any other path finds
				// nothing there, exactly as it would on a real machine.
				const outputBase = args[args.indexOf('-of') + 1];
				if (
					!behaviour.execError &&
					!behaviour.writesNoOutput &&
					outputBase !== undefined
				) {
					files.set(
						`${outputBase}.json`,
						behaviour.output ?? DEFAULT_OUTPUT,
					);
				}
				callback(behaviour.execError ?? null, '', '');
			},
		},
		fs: {
			writeFileSync: (path: string, data: unknown): void => {
				surface.written.push(path);
				files.set(path, String(data));
			},
			readFileSync: (path: string): string => {
				const contents = files.get(path);
				if (contents === undefined) {
					// What Node throws for a path that is not there. The
					// provider's "did not produce an output file" branch is
					// the one that reads it.
					throw Object.assign(
						new Error(
							`ENOENT: no such file or directory, open '${path}'`,
						),
						{ code: 'ENOENT' },
					);
				}
				return contents;
			},
			rmSync: (path: string): void => {
				surface.removed.push(path);
				files.delete(path);
			},
		},
		os: { tmpdir: (): string => '/tmp' },
		path: { join: (...parts: string[]): string => parts.join('/') },
	};
	(window as RequireWindow).require = (id: string): unknown => modules[id];
	return surface;
}
