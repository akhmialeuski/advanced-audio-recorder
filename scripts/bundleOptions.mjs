/**
 * The esbuild options every bundle of this plugin is built with.
 *
 * esbuild.config.mjs builds three bundles - the main plugin, the encoding
 * worker and the audio engine - and each of them goes through
 * pluginBundle(), so what one bundle is promised about the runtime it lands
 * in, every bundle is. The tests build through the same function, so what
 * they run is what the release ships.
 */

import { fileURLToPath } from "node:url";

/**
 * The language level the bundles are lowered to. Syntax newer than this is
 * rewritten by esbuild; class fields and top-level await stay as written.
 *
 * Lowering rewrites syntax only. Where the rewritten code still needs
 * something from the runtime that the oldest Electron Obsidian runs on lacks,
 * the runtime prelude below provides it.
 */
export const BUNDLE_TARGET = "es2022";

/**
 * Modules evaluated ahead of everything else in every bundle, whatever the
 * entry imports and in whatever order: esbuild's `inject` places them first.
 *
 * src/platform/disposeSymbols.ts gives the realm Symbol.dispose and
 * Symbol.asyncDispose where it has neither, which the lowered `using` and
 * `await using` look releases up by. It has to come first in the worker and
 * the engine as much as in the main bundle: before Electron 35 a worker has
 * neither symbol, whatever Electron's Node.js provides to the window.
 */
export const RUNTIME_PRELUDE = [
	fileURLToPath(new URL("../src/platform/disposeSymbols.ts", import.meta.url)),
];

/**
 * Options shared by every bundle, merged under the bundle's own.
 * @param {import("esbuild").BuildOptions} options - The bundle's own options
 * @returns {import("esbuild").BuildOptions} The options to build with
 */
export function pluginBundle(options) {
	return {
		bundle: true,
		target: BUNDLE_TARGET,
		...options,
		inject: [...RUNTIME_PRELUDE, ...(options.inject ?? [])],
	};
}
