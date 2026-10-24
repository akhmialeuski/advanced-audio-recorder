/**
 * The one way plugin code reaches the audio engine (mediabunny and its FLAC
 * and MP3 encoders). Every caller awaits loadAudioEngine() where it needs an
 * engine value, so the engine is loaded on first use rather than when Obsidian
 * evaluates the plugin, and how it is loaded is decided in this module alone.
 * @module audio/audioEngine
 */

/** The engine's values, as re-exported by the runtime module. */
export type AudioEngine = typeof import('./mediabunnyRuntime');

/**
 * Loads the audio engine, once per session.
 * @returns The engine module
 */
export function loadAudioEngine(): Promise<AudioEngine> {
	return import('./mediabunnyRuntime');
}
