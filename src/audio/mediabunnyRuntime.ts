/**
 * The part of mediabunny the plugin runs, re-exported for dynamic import.
 * Plugin code reaches it as `await import('./mediabunnyRuntime')`, so esbuild
 * keeps mediabunny behind a lazy initializer instead of running it at the
 * bundle's top level, which Obsidian times as the plugin's load. The static
 * re-export lets esbuild tree-shake mediabunny down to these names, which a
 * dynamic import of the package itself would not.
 * @module audio/mediabunnyRuntime
 */

export {
	ALL_FORMATS,
	AdtsOutputFormat,
	AudioBufferSource,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferSource,
	BufferTarget,
	Conversion,
	FlacOutputFormat,
	Input,
	Mp3OutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	Output,
	Quality,
	UrlSource,
	WavOutputFormat,
	WebMOutputFormat,
	canEncodeAudio,
} from 'mediabunny';
