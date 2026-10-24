/**
 * Build-time globals injected by esbuild (see esbuild.config.mjs).
 * @module globals
 */

/**
 * Bundled source of the encoding Web Worker, without the audio engine it
 * runs after, injected via an esbuild define. Undefined in environments
 * that bypass the bundler (tests).
 */
declare const __ENCODING_WORKER_SOURCE__: string | undefined;

/**
 * The audio engine as one classic script, injected via an esbuild define
 * and carried once for the main thread and the encoding worker. Undefined
 * in tests and inside the worker, which reach the runtime module directly.
 */
declare const __AUDIO_ENGINE_SOURCE__: string | undefined;

/**
 * The global name the engine script declares the engine under, in the main
 * window and in the encoding worker alike.
 */
declare const __AUDIO_ENGINE_GLOBAL__: string;

/**
 * Prefixed AudioContext constructor still shipped by older WebKit;
 * probed as a fallback where a context is created from window.
 */
interface Window {
	webkitAudioContext?: typeof AudioContext;
}
