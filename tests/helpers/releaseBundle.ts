/**
 * Running plugin modules the way the release ships them, on a runtime other
 * than the one Jest provides.
 *
 * Two things stand between a Jest test and the shipped code. ts-jest compiles
 * each module with TypeScript, while the release is bundled by esbuild, and
 * the two lower newer syntax (`using`, `await using`) to different helpers
 * with different failure modes. And Jest's realm is whatever tests/setup.ts
 * made it. A test about what the shipped code does on a given Electron build
 * can rely on neither: it bundles the modules through the release's own options
 * (scripts/bundleOptions.mjs) and evaluates the bundle in a fresh realm set up
 * like that Electron build.
 *
 * The bundle is built in a child process because the build options are an ES
 * module, which Jest's CommonJS runtime cannot import, and because esbuild
 * refuses to run under the jsdom environment, whose Uint8Array is not Node's.
 * @module tests/helpers/releaseBundle
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { createContext, runInContext, type Context } from 'vm';

/** Repository root: the build options resolve their paths from here. */
const ROOT = join(__dirname, '..', '..');

/** The global an `iife` bundle hands its exports back through. */
const IIFE_GLOBAL = '__releaseBundle';

/**
 * The child that bundles: it reads `{ contents, format }` as JSON on
 * stdin and writes the bundle to stdout. Externals and defines follow the
 * main build in esbuild.config.mjs; the engine and the worker are left out,
 * so a bundle that reaches for either fails loudly rather than loading them.
 */
const BUNDLER = `
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { pluginBundle } from './scripts/bundleOptions.mjs';

const { contents, format } = JSON.parse(readFileSync(0, 'utf8'));
const result = await build(
	pluginBundle({
		stdin: { contents, loader: 'ts', resolveDir: process.cwd() },
		format,
		globalName: format === 'iife' ? '${IIFE_GLOBAL}' : undefined,
		external: ['obsidian'],
		define: {
			__AUDIO_ENGINE_SOURCE__: JSON.stringify(''),
			__AUDIO_ENGINE_GLOBAL__: JSON.stringify('__aarAudioEngine'),
			__ENCODING_WORKER_SOURCE__: 'undefined',
		},
		write: false,
		logLevel: 'silent',
	}),
);
process.stdout.write(result.outputFiles[0].text);
`;

/**
 * How a bundle is wrapped: `cjs` as the main plugin bundle is, `iife` as the
 * encoding worker and the audio engine are.
 */
export type BundleFormat = 'cjs' | 'iife';

/** Bundles already built, by entry and format; a build costs a process. */
const built = new Map<string, string>();

/**
 * Bundles an entry the way the release bundles the plugin.
 * @param contents - TypeScript entry, importing from `./src/...`
 * @param format - How the bundle is wrapped
 * @returns The bundle's source text
 */
export function bundleLikeRelease(
	contents: string,
	format: BundleFormat,
): string {
	const key = `${format}\n${contents}`;
	const cached = built.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const text = execFileSync(
		process.execPath,
		['--input-type=module', '-e', BUNDLER],
		{
			cwd: ROOT,
			input: JSON.stringify({ contents, format }),
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	built.set(key, text);
	return text;
}

/**
 * What a runtime offers of explicit resource management, in the realm a
 * bundle runs in.
 *
 * Electron's renderer carries two engines: Chromium's V8, and Node.js, which
 * runs in the window when Node integration is on, as it is in Obsidian. V8
 * ships `Symbol.dispose` and `Symbol.asyncDispose` from Chromium 134
 * (Electron 35); Node.js adds both itself from 18.18.0 and 20.4.0, but only to
 * the window - a dedicated worker gets no Node.js. Obsidian runs on whatever
 * installer the user has, down to Electron 25 (Chromium 114, Node.js 18.15.0),
 * whose window and workers have neither.
 */
export enum DisposeSymbols {
	/** Neither symbol, as on Electron 25 and in any worker before Electron 35. */
	Absent = 'absent',
	/** Both, read-only and fixed, as V8 or Node.js define them. */
	Native = 'native',
}

/** A realm to run a bundle in, and its way back into it. */
export interface Realm {
	context: Context;
	/**
	 * Evaluates an expression in the realm.
	 * @param code - The expression
	 * @returns Its value
	 */
	run<T>(code: string): T;
}

/**
 * A stand-in for the realm's Symbol without the two disposal symbols, keeping
 * every other well-known symbol as itself, so a realm models a runtime that
 * predates them whatever Node.js runs the suite: from Node.js 24 a fresh V8
 * realm has them natively, and natively they cannot be deleted.
 */
const LEGACY_SYMBOL = `((Native) => {
	const Legacy = function Symbol(description) {
		if (new.target) {
			throw new TypeError('Symbol is not a constructor');
		}
		return Native(description);
	};
	for (const key of Reflect.ownKeys(Native)) {
		if (key !== 'dispose' && key !== 'asyncDispose' && key !== 'length' && key !== 'name' && key !== 'prototype') {
			Object.defineProperty(Legacy, key, Object.getOwnPropertyDescriptor(Native, key));
		}
	}
	Legacy.prototype = Native.prototype;
	return Legacy;
})(Symbol)`;

/** Both symbols as V8 and Node.js define them: not writable, not configurable. */
const NATIVE_SYMBOLS = `
	Object.defineProperty(Symbol, 'dispose', { value: Symbol('Symbol.dispose') });
	Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol('Symbol.asyncDispose') });
`;

/**
 * A fresh realm offering what the given runtime offers, with the host objects
 * a bundle reaches for at load: the CommonJS wrapper, and a module answering
 * for the externals.
 * @param symbols - What the realm's Symbol carries
 * @param externals - Modules `require` answers with, by id
 * @returns The realm
 */
export function createRealm(
	symbols: DisposeSymbols,
	externals: Record<string, unknown> = {},
): Realm {
	const exportsObject = {};
	const context = createContext({
		console,
		module: { exports: exportsObject },
		exports: exportsObject,
		require: (id: string): unknown => {
			if (!(id in externals)) {
				throw new Error(
					`The bundle required ${id}, which the realm lacks`,
				);
			}
			return externals[id];
		},
	});
	runInContext(`globalThis.Symbol = ${LEGACY_SYMBOL};`, context);
	if (symbols === DisposeSymbols.Native) {
		runInContext(NATIVE_SYMBOLS, context);
	}
	return {
		context,
		run: <T>(code: string): T => runInContext(code, context) as T,
	};
}

/**
 * What the audio engine does to the realm when it first loads: mediabunny
 * gives a runtime without `Symbol.dispose` one of its own, and nothing for
 * `Symbol.asyncDispose` (node_modules/mediabunny/dist/modules/src/misc.js,
 * polyfillSymbolDispose). It runs on first use - a file-info read, the
 * transcribe dialog's duration probe - long after the plugin loaded.
 * @param realm - The realm the engine loads into
 */
export function loadEngineInto(realm: Realm): void {
	realm.run(`Symbol.dispose ??= Symbol('Symbol.dispose');`);
}

/**
 * Evaluates a bundle in a realm and hands back what it exports.
 * @param realm - Where the bundle runs
 * @param bundle - The bundle's source text
 * @param format - How the bundle is wrapped
 * @returns The bundle's exports
 */
export function evaluateBundle<T>(
	realm: Realm,
	bundle: string,
	format: BundleFormat,
): T {
	runInContext(bundle, realm.context);
	return realm.run<T>(format === 'cjs' ? 'module.exports' : IIFE_GLOBAL);
}
