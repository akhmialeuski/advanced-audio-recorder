/**
 * Build-time globals injected by esbuild (see esbuild.config.mjs).
 * @module globals
 */

/**
 * Bundled source of the encoding Web Worker, injected via an esbuild
 * define. Undefined in environments that bypass the bundler (tests).
 */
declare const __ENCODING_WORKER_SOURCE__: string | undefined;
