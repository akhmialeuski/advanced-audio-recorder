/**
 * The one way plugin code reaches the audio engine (mediabunny and its FLAC
 * and MP3 encoders). Every caller awaits loadAudioEngine() where it needs an
 * engine value, so the engine is loaded on first use rather than when Obsidian
 * evaluates the plugin, and how it is loaded is decided in this module alone.
 *
 * The build carries the engine once, as a classic script (see
 * esbuild.config.mjs): the main thread runs it from a Blob URL here, and the
 * encoding worker runs the same script ahead of its own code. Where the script
 * is absent, in tests and inside the worker, the engine is the runtime module
 * itself.
 * @module audio/audioEngine
 */

import { errorMessage } from '../errors';

/** The engine's values, as re-exported by the runtime module. */
export type AudioEngine = typeof import('./mediabunnyRuntime');

/**
 * The engine script the build carries, or null where it carries none. esbuild
 * writes a define's value at every place that reads it, so this constant is
 * the one reader of the engine text and everyone else reads the constant.
 */
const AUDIO_ENGINE_SCRIPT: string | null =
	typeof __AUDIO_ENGINE_SOURCE__ === 'string'
		? __AUDIO_ENGINE_SOURCE__
		: null;

/**
 * The script the encoding worker starts from: the engine first, declaring
 * the global the worker's own code reads it through, then that code.
 * @param workerSource - The worker's own code, or null when the build
 * injected none
 * @returns The whole worker script, or null when either part is missing
 */
export function encodingWorkerScript(
	workerSource: string | null,
): string | null {
	return workerSource !== null && AUDIO_ENGINE_SCRIPT !== null
		? `${AUDIO_ENGINE_SCRIPT}\n${workerSource}`
		: null;
}

/** The engine load every caller shares, started by the first one. */
let engine: Promise<AudioEngine> | null = null;

/**
 * Loads the audio engine, once per session.
 * @returns The engine module
 */
export function loadAudioEngine(): Promise<AudioEngine> {
	// Only a typeof test of the define itself is folded by esbuild, which then
	// drops the runtime import and keeps the engine out of the bundle's own
	// code. The same test is what makes the constant a string.
	engine ??=
		typeof __AUDIO_ENGINE_SOURCE__ === 'string'
			? runEngineScript(AUDIO_ENGINE_SCRIPT as string)
			: import('./mediabunnyRuntime');
	return engine;
}

/**
 * Runs the engine script the way Obsidian loads Prism and Mermaid, through a
 * script element, and reads the engine from the global the script declares.
 * The element goes into the plugin's own window on purpose: plugin code runs
 * there and reads the global there, whichever window is active. A dynamic
 * import of the Blob URL would hand the module back directly, but the
 * obsidianmd lint set refuses an import() of a computed URL
 * (no-unsanitized/method).
 * @param source - The engine script the build carries
 * @returns The engine module
 */
async function runEngineScript(source: string): Promise<AudioEngine> {
	const url = URL.createObjectURL(
		new Blob([source], { type: 'text/javascript' }),
	);
	const script = createEl('script', { attr: { src: url } });
	// A classic script that throws while it is parsed or run still fires load,
	// and the browser reports the exception only to the window's error event
	let failure: unknown;
	const onWindowError = (event: ErrorEvent): void => {
		if (event.filename === url) {
			failure = event.error ?? event.message;
		}
	};
	window.addEventListener('error', onWindowError);
	try {
		await new Promise<void>((resolve, reject) => {
			script.addEventListener('load', () => {
				resolve();
			});
			script.addEventListener('error', () => {
				reject(new Error('The audio engine script failed to load'));
			});
			document.head.appendChild(script);
		});
	} finally {
		window.removeEventListener('error', onWindowError);
		script.remove();
		URL.revokeObjectURL(url);
	}
	const loaded = (
		window as unknown as Record<string, AudioEngine | undefined>
	)[__AUDIO_ENGINE_GLOBAL__];
	if (!loaded) {
		throw new Error(
			`The audio engine script declared no ${__AUDIO_ENGINE_GLOBAL__}` +
				(failure === undefined ? '' : `: ${errorMessage(failure)}`),
			{ cause: failure },
		);
	}
	return loaded;
}
