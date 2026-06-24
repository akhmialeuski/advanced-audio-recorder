/**
 * Constants for the Audio Recorder plugin.
 * @module constants
 */

/**
 * Prefix for all plugin logs.
 */
export const PLUGIN_LOG_PREFIX = '[AudioRecorder]';

export const FORMAT_WAV = 'wav';
export const FORMAT_WEBM = 'webm';
export const FORMAT_OGG = 'ogg';
export const FORMAT_MP3 = 'mp3';
export const FORMAT_MP4 = 'mp4';
export const FORMAT_M4A = 'm4a';
export const FORMAT_AAC = 'aac';
export const FORMAT_FLAC = 'flac';

export const AUDIO_EXTENSIONS = [
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
	FORMAT_FLAC,
];

/** Interval between MediaRecorder data chunks in milliseconds. */
export const CHUNK_TIMESLICE_MS = 5000;

/**
 * Maximum time to wait for a MediaRecorder stop event in milliseconds.
 * If the audio subsystem dies mid-stop the event never fires; without
 * the timeout the stop sequence would hang forever with the status bar
 * stuck on "Saving".
 */
export const RECORDER_STOP_TIMEOUT_MS = 5000;

/** Maximum in-memory buffer size for mobile recordings before flushing to disk. */
export const MOBILE_BUFFER_LIMIT_BYTES = 50 * 1024 * 1024;

/** PCM buffer flush threshold for WAV desktop recordings. */
export const PCM_FLUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Desktop MediaRecorder chunk buffer flush threshold before writing to disk. */
export const DESKTOP_FLUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Common MIME type prefix for audio formats. */
export const MIME_TYPE_AUDIO_PREFIX = 'audio/';

/** Default audio sample rate in Hz. */
export const DEFAULT_SAMPLE_RATE = 44100;

/** Default encoder bitrate in bits per second. */
export const DEFAULT_BITRATE = 128000;

/** Seconds in one minute. */
export const SECONDS_PER_MINUTE = 60;

/** Seconds in one hour. */
export const SECONDS_PER_HOUR = 3600;

/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000;

/** Default duration of one split part in minutes. */
export const DEFAULT_SPLIT_CHUNK_MINUTES = 15;

/** Minimum allowed split part duration in minutes. */
export const MIN_SPLIT_CHUNK_MINUTES = 1;

/** Maximum allowed split part duration in minutes. */
export const MAX_SPLIT_CHUNK_MINUTES = 180;

/** Default filename suffix for split parts (e.g. "-part1", "-part2"). */
export const DEFAULT_SPLIT_PART_SUFFIX = 'part';

/**
 * Allowed characters for the split part suffix. The suffix ends up in
 * file names and in link-matching regular expressions, so it must stay
 * free of path separators and regex metacharacters.
 */
export const SPLIT_PART_SUFFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/** User-facing description of the split part suffix character rule. */
export const SPLIT_PART_SUFFIX_RULE_TEXT =
	'Part suffix may contain only letters, digits, hyphens, and underscores.';

// Enhanced audio player
// The player's elements are fixed (not user-configurable); these are the
// values it always renders with.

/** Waveform height in pixels. */
export const PLAYER_WAVEFORM_HEIGHT = 48;

/** Seconds skipped by the player's skip-forward/back buttons. */
export const PLAYER_SKIP_SECONDS = 10;

/** Playback rate applied to new players. */
export const PLAYER_PLAYBACK_RATE = 1;

/**
 * Fixed waveform resolution decoded and cached per file, independent of the
 * rendered width. The display downsamples this to the current width, so
 * resizing or switching view modes never triggers a re-decode.
 */
export const WAVEFORM_CACHE_BUCKETS = 1024;

/**
 * Grace period before a shared audio element is released after its last
 * player unloads. A view-mode switch unloads the old player and creates the
 * new one within a frame or two, so this keeps the same audio element (and
 * its playback) alive across the switch instead of stopping and restarting.
 */
export const SHARED_AUDIO_GRACE_MS = 500;

/** Selectable playback-rate presets shown in the player and settings. */
export const PLAYER_PLAYBACK_RATE_PRESETS = [
	0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

/** Number of waveform bars drawn per 100 pixels of player width. */
export const PLAYER_WAVEFORM_BARS_PER_100PX = 50;

/**
 * Fallback color for the played portion of the waveform, used only when
 * the theme CSS variable `--aar-waveform-played` is unavailable.
 */
export const PLAYER_WAVEFORM_FALLBACK_PLAYED = '#7c6fda';

/**
 * Fallback color for the unplayed portion of the waveform, used only when
 * the theme CSS variable `--aar-waveform-unplayed` is unavailable.
 */
export const PLAYER_WAVEFORM_FALLBACK_UNPLAYED = '#b3b3b3';

/** Loop state applied to a newly created shared audio element. */
export const PLAYER_LOOP = false;

/** Seconds the seek area moves per arrow-key press. */
export const PLAYER_SEEK_KEYBOARD_STEP_SECONDS = 5;

/**
 * Animation frames to wait for the embed to attach to the document before
 * giving up the editor-mode probe (the embed-registry path renders while
 * still detached). At ~60fps this is roughly 1.5 seconds.
 */
export const PLAYER_ATTACH_WAIT_FRAMES = 90;

/**
 * Animation frames to retry drawing the waveform while the seek area still
 * reports a zero width (layout has not settled yet).
 */
export const PLAYER_WAVEFORM_REDRAW_RETRIES = 10;

/**
 * Fallback seek-area width in pixels used to size the waveform before the
 * real layout width is known.
 */
export const PLAYER_WAVEFORM_FALLBACK_WIDTH_PX = 600;

/** Maximum number of distinct waveforms retained in the bounded peak cache. */
export const WAVEFORM_CACHE_MAX_ENTRIES = 64;

/**
 * Number of high-resolution buckets computed per progressive chunk before
 * yielding control back to the event loop, so peak extraction for a large
 * file never blocks the main thread in a single long synchronous pass.
 */
export const WAVEFORM_PROGRESSIVE_CHUNK_BUCKETS = 16;

/**
 * Sample rate (Hz) the waveform decoder resamples to. The waveform only needs
 * an amplitude envelope, so decoding through a low-rate OfflineAudioContext
 * keeps a long recording's decoded PCM small instead of allocating the full
 * native-rate buffer (which can reach hundreds of MB for an hour of stereo).
 * 8 kHz is the safe minimum and ample for peak extraction.
 */
export const WAVEFORM_DECODE_SAMPLE_RATE = 8000;

/**
 * Upper bound on the encoded file size the waveform will decode. Decoding holds
 * the whole encoded file in memory, and decodeAudioData can transiently
 * allocate several times that before the low-rate resample, so a pathological
 * multi-gigabyte file would risk an out-of-memory spike for a cosmetic
 * waveform. Realistic recordings (including hour-long uncompressed WAV) stay
 * well under this ceiling; only pathological files fall back to the plain
 * (still seekable) bar. This is a safety valve, not the old per-size skip:
 * everything below it is still drawn progressively.
 */
export const WAVEFORM_MAX_DECODE_BYTES = 1024 * 1024 * 1024;

/**
 * Distance (px) from the viewport at which a player decodes its waveform.
 * The waveform is decoded lazily through an IntersectionObserver so a long
 * note with many recordings does not decode every embed up front; this margin
 * starts the decode just before the player scrolls into view.
 */
export const PLAYER_WAVEFORM_PREFETCH_MARGIN_PX = 200;

// Transcription

/**
 * Transcription engine ids. The single source for the string values used as
 * the provider `id`, the settings discriminator, and the keys of the engine
 * label and capability maps, so the literals are never hand-typed across the
 * codebase. {@link TranscriptionProviderId} is derived from these values.
 */
export const TRANSCRIPTION_PROVIDER_IDS = {
	WHISPER_API: 'whisper-api',
	LOCAL_WHISPER: 'local-whisper',
	DEEPGRAM: 'deepgram',
} as const;

/**
 * Sample rate, in Hz, that audio is resampled to before transcription.
 * 16 kHz mono is the input Whisper-family models are trained on and
 * keeps uploads small.
 */
export const TRANSCRIBE_SAMPLE_RATE = 16000;

/** Bytes per second of 16 kHz mono 16-bit PCM (the chunk upload rate). */
export const TRANSCRIBE_BYTES_PER_SEC = TRANSCRIBE_SAMPLE_RATE * 2;

/**
 * Default upload size limit per request, in megabytes, for the Whisper
 * API. OpenAI's limit is 25 MB; chunks are sized to stay under it.
 */
export const DEFAULT_TRANSCRIBE_CHUNK_MB = 24;

/** Default OpenAI-compatible transcription endpoint base URL. */
export const DEFAULT_WHISPER_API_BASE_URL = 'https://api.openai.com/v1';

/** Default Whisper API model id. */
export const DEFAULT_WHISPER_API_MODEL = 'whisper-1';

/**
 * Seed model ids for the OpenAI-compatible Whisper API. They populate the
 * model picker on first run and can be extended with custom ids in settings.
 * All return `verbose_json` with segment timestamps, which the provider
 * relies on: `whisper-1` is OpenAI's; the `*-v3*` ids are served by Groq and
 * other compatible hosts. (OpenAI's newer `gpt-4o-transcribe` models are
 * omitted: they do not support `verbose_json`, so they are incompatible with
 * the timed output the plugin requests.)
 */
export const WHISPER_API_MODEL_SUGGESTIONS = [
	'whisper-1',
	'whisper-large-v3',
	'whisper-large-v3-turbo',
	'distil-whisper-large-v3-en',
];

/** Where to find the model list for the configured Whisper API host. */
export const WHISPER_API_MODELS_DOC_URL =
	'https://platform.openai.com/docs/guides/speech-to-text';

/**
 * Hard per-request upload ceiling for the OpenAI Whisper API, in bytes
 * (25 MB). Files at or under this are uploaded in their original
 * container; larger recordings are decoded and split into WAV chunks that
 * stay under the limit.
 */
export const WHISPER_API_MAX_REQUEST_BYTES = 25 * 1024 * 1024;

/** Default Deepgram pre-recorded API base URL. */
export const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';

/** Default Deepgram model id. */
export const DEFAULT_DEEPGRAM_MODEL = 'nova-3';

/**
 * Seed Deepgram speech-to-text model ids for the pre-recorded API. They
 * populate the model picker on first run and can be extended with custom ids
 * in settings. Grouped by family: Nova-3, Nova-2 and its named variants,
 * Nova, Enhanced (`enhanced`, `enhanced-meeting`, `enhanced-phonecall`,
 * `enhanced-finance`), Base, and the hosted Whisper sizes. The real-time
 * Flux family is omitted — it targets streaming voice agents, not the
 * pre-recorded transcription this plugin uses. See
 * {@link DEEPGRAM_MODELS_DOC_URL} for the authoritative, current list.
 */
export const DEEPGRAM_MODEL_SUGGESTIONS = [
	'nova-3',
	'nova-3-general',
	'nova-3-medical',
	'nova-2',
	'nova-2-general',
	'nova-2-meeting',
	'nova-2-phonecall',
	'nova-2-voicemail',
	'nova-2-finance',
	'nova-2-conversationalai',
	'nova-2-video',
	'nova-2-medical',
	'nova-2-drivethru',
	'nova-2-automotive',
	'nova-2-atc',
	'nova',
	'nova-general',
	'nova-phonecall',
	'enhanced',
	'enhanced-general',
	'enhanced-meeting',
	'enhanced-phonecall',
	'enhanced-finance',
	'base',
	'base-general',
	'base-meeting',
	'base-phonecall',
	'base-voicemail',
	'base-finance',
	'base-conversationalai',
	'base-video',
	'whisper',
	'whisper-tiny',
	'whisper-base',
	'whisper-small',
	'whisper-medium',
	'whisper-large',
];

/** Authoritative, current list of Deepgram speech-to-text models. */
export const DEEPGRAM_MODELS_DOC_URL =
	'https://developers.deepgram.com/docs/model';

/**
 * Hard per-request upload ceiling for Deepgram pre-recorded audio, in
 * bytes (2 GB). Deepgram diarizes a whole request with consistent speaker
 * numbering, so files under this are sent in one piece instead of chunked.
 */
export const DEEPGRAM_MAX_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;

/** Default OpenAI-compatible chat base URL for LLM post-processing. */
export const DEFAULT_LLM_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Default OpenAI-compatible chat model for LLM post-processing. */
export const DEFAULT_LLM_OPENAI_MODEL = 'gpt-4o-mini';

/** Default Anthropic Messages API base URL. */
export const DEFAULT_LLM_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/** Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default Anthropic model for transcript post-processing. */
export const DEFAULT_LLM_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** Default local Ollama base URL for LLM post-processing. */
export const DEFAULT_LLM_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/** Minimum configurable transcription chunk size in megabytes. */
export const MIN_TRANSCRIBE_CHUNK_MB = 1;

/**
 * Maximum configurable transcription chunk size in megabytes. Capped at
 * 24 to stay under OpenAI's 25 MB per-request limit.
 */
export const MAX_TRANSCRIBE_CHUNK_MB = 24;

/** Default maximum output tokens for LLM post-processing. */
export const DEFAULT_LLM_MAX_TOKENS = 4096;

/** Minimum configurable LLM output token budget. */
export const MIN_LLM_MAX_TOKENS = 512;

/** Maximum configurable LLM output token budget. */
export const MAX_LLM_MAX_TOKENS = 32000;

/**
 * Floor timeout, in milliseconds, for a transcription HTTP request.
 * Obsidian's requestUrl exposes no abort signal, so the helper races the
 * request against a deadline to bound a hung endpoint (e.g. a misconfigured
 * local Ollama/whisper server) instead of stalling forever. Whole-file
 * uploads scale above this floor with their payload size; see
 * TRANSCRIBE_UPLOAD_BYTES_PER_MS and TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS.
 */
export const TRANSCRIBE_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Hard ceiling on a single transcription request timeout, in milliseconds
 * (30 minutes). A whole-file upload (e.g. a multi-hundred-MB Deepgram
 * request) scales its timeout with payload size up to this bound, so a
 * large but healthy upload is never aborted prematurely.
 */
export const TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;

/**
 * Assumed sustained upload throughput, in bytes per millisecond (~1 MB/s),
 * used to scale a request timeout with its payload size. Deliberately
 * conservative so a slow connection still gets enough time to finish.
 */
export const TRANSCRIBE_UPLOAD_BYTES_PER_MS = 1024;

/**
 * Timeout, in milliseconds, for an LLM post-processing request (5 minutes).
 * Longer than the transcription floor because a capable model cleaning or
 * summarizing a long transcript can legitimately take minutes; a shorter
 * deadline would discard completed (and billed) work as a false timeout.
 */
export const LLM_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Maximum bytes buffered from the local whisper.cpp child process's stdout
 * and stderr (64 MB). whisper.cpp prints the full transcript to stdout, so
 * Node's 1 MB default would kill the process on a long recording; a
 * generous ceiling lets long offline transcriptions complete.
 */
export const LOCAL_WHISPER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * GGML model names available for whisper.cpp, shown in settings so the user
 * knows which model files to download. Names ending in `.en` are
 * English-only; the rest are multilingual. The plugin points at a model
 * file path, so these are guidance rather than selectable ids.
 */
export const LOCAL_WHISPER_MODEL_NAMES = [
	'tiny',
	'tiny.en',
	'base',
	'base.en',
	'small',
	'small.en',
	'medium',
	'medium.en',
	'large-v3',
	'large-v3-turbo',
];

/** Where to download whisper.cpp GGML model files. */
export const LOCAL_WHISPER_MODELS_DOC_URL =
	'https://huggingface.co/ggerganov/whisper.cpp';

/**
 * Upper bound of the progress fraction reserved for chunk transcription.
 * The remaining 0.95..1 band covers LLM post-processing and finalization,
 * so the bar never jumps backwards when post-processing starts.
 */
export const TRANSCRIBE_CHUNK_PROGRESS_CEILING = 0.95;

// ── Input DSP processing ────────────────────────────────────────────

/** Default high-pass filter cutoff in Hz (removes low rumble). */
export const DEFAULT_INPUT_HIGHPASS_HZ = 80;

/** Minimum configurable high-pass cutoff in Hz. */
export const MIN_INPUT_HIGHPASS_HZ = 20;

/** Maximum configurable high-pass cutoff in Hz. */
export const MAX_INPUT_HIGHPASS_HZ = 300;

/** Default noise-gate threshold in dBFS. */
export const DEFAULT_INPUT_GATE_THRESHOLD_DB = -50;

/** Minimum configurable noise-gate threshold in dBFS. */
export const MIN_INPUT_GATE_THRESHOLD_DB = -80;

/** Maximum configurable noise-gate threshold in dBFS. */
export const MAX_INPUT_GATE_THRESHOLD_DB = -20;

/** Default makeup gain in dB applied after leveling compression. */
export const DEFAULT_INPUT_LEVELING_MAKEUP_DB = 6;

/** Minimum configurable leveling makeup gain in dB. */
export const MIN_INPUT_LEVELING_MAKEUP_DB = 0;

/** Maximum configurable leveling makeup gain in dB. */
export const MAX_INPUT_LEVELING_MAKEUP_DB = 24;

/**
 * Upper bound, in bytes, on the encoded size of a file the on-demand
 * audio cleanup will read and decode. Checked before decoding so a
 * pathologically large file is rejected up front instead of allocating
 * the whole decoded buffer (and a larger Float32 working copy) in the
 * renderer. Mirrors the player's WAVEFORM_MAX_DECODE_BYTES ceiling.
 */
export const MAX_AUDIO_CLEANUP_BYTES = 1024 * 1024 * 1024;

/**
 * Upper bound, in seconds, on the duration of a file the on-demand audio
 * cleanup will process. The noise gate and WAV encoding run as a single
 * synchronous pass on the main thread, so a very long file would freeze
 * the UI; above this the action asks the user to split the file first.
 */
export const MAX_AUDIO_CLEANUP_SECONDS = 2 * 60 * 60;
