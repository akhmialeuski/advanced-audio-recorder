/**
 * The part of mediabunny the plugin runs, together with the registration of
 * its FLAC and MP3 extension encoders, which must share mediabunny's encoder
 * registry. Plugin code reaches it only through loadAudioEngine() in
 * audioEngine.ts. The static re-export lets esbuild tree-shake mediabunny down
 * to these names, which a dynamic import of the package itself would not.
 * @module audio/mediabunnyRuntime
 */

export { registerFlacEncoder } from '@mediabunny/flac-encoder';
export { registerMp3Encoder } from '@mediabunny/mp3-encoder';

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
