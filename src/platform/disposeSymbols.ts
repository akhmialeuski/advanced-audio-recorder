/**
 * The two well-known symbols explicit resource management keys on, for the
 * runtimes that predate them.
 *
 * The plugin releases its resources with `using` and `await using`, which
 * esbuild lowers to helpers for the ES2022 target. The helpers are only half of
 * the feature: they find a resource's release under `Symbol.dispose` and
 * `Symbol.asyncDispose`, and those are the runtime's to provide. Obsidian runs
 * on whatever Electron its installer shipped, and down to Electron 25
 * (Chromium 114, Node.js 18.15) neither symbol exists: V8 has them from
 * Chromium 134 (Electron 35), and Node.js adds them to the window from 18.18.0
 * and 20.4.0, but never to a worker, where Node.js does not run.
 *
 * Where they are missing, the two sides of a `using` disagree. The lowered
 * helper falls back to `Symbol.for('Symbol.dispose')`, while the plugin's own
 * `[Symbol.dispose]` reads undefined and stores the release under the
 * property "undefined" - and a class does so once, when its module loads.
 * Every `await using` then threw "Object not disposable" (issue #164).
 *
 * So this module runs ahead of every other in each bundle the plugin ships:
 * esbuild injects it there (scripts/bundleOptions.mjs), so no import order
 * can put a class definition in front of it. It fills in only what the
 * runtime lacks, and leaves a runtime's own symbols as they are.
 * @module platform/disposeSymbols
 */

/** The well-known symbols this module provides, by property name. */
const DISPOSE_SYMBOL_NAMES = ['dispose', 'asyncDispose'] as const;

/**
 * Gives a Symbol constructor whichever of `dispose` and `asyncDispose` it
 * lacks.
 *
 * A missing one becomes the registered `Symbol.for('Symbol.<name>')`, the
 * symbol esbuild's lowered `using` already falls back to, so a lookup made
 * before this ran - by another plugin's bundle, say - still finds the same
 * key. It is defined as the built-in ones are, read-only and fixed: a polyfill
 * running later, such as the audio engine's own for `Symbol.dispose`, cannot
 * move a key that objects are already stored under.
 * @param host - The realm's Symbol, or a stand-in for it
 */
export function provideDisposeSymbols(host: object): void {
	for (const name of DISPOSE_SYMBOL_NAMES) {
		if (Reflect.get(host, name) === undefined) {
			Object.defineProperty(host, name, {
				value: Symbol.for(`Symbol.${name}`),
				writable: false,
				enumerable: false,
				configurable: false,
			});
		}
	}
}

provideDisposeSymbols(Symbol);
