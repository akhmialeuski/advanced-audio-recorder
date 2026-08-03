/**
 * Constants for the Audio Recorder plugin.
 * @module constants
 */

/**
 * Prefix for all plugin logs.
 */
export const PLUGIN_LOG_PREFIX = '[AudioRecorder]';

/**
 * Public documentation home. Points at the `docs/` folder on GitHub, whose
 * `index.md` renders automatically as the folder landing page, so the in-app
 * settings link opens the full guides without the user hunting through the
 * repository.
 */
export const DOCS_URL =
	'https://github.com/akhmialeuski/advanced-audio-recorder/tree/master/docs';

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

/**
 * Maximum time to wait for the PCM capture worklet to acknowledge a
 * flush request in milliseconds. If the audio subsystem dies the
 * `flushed` reply never arrives; without the timeout stop() would hang
 * before releasing the AudioContext and the worklet blob URL.
 */
export const PCM_FLUSH_TIMEOUT_MS = 5000;

/** Bytes in one megabyte (binary), for size settings expressed in MB. */
export const BYTES_PER_MB = 1024 * 1024;

/** Maximum in-memory buffer size for mobile recordings before flushing to disk. */
export const MOBILE_BUFFER_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Upper bound on the encoded file size decode-heavy features (waveform,
 * cleanup, split) will load on mobile. The mobile WebView gets a far
 * smaller memory budget than the desktop renderer before the OS kills
 * the app outright, so the desktop ceiling
 * ({@link WAVEFORM_MAX_DECODE_BYTES}) is unusable there.
 */
export const MOBILE_MAX_DECODE_BYTES = 256 * 1024 * 1024;

/**
 * Mobile counterpart of {@link MAX_AUDIO_CLEANUP_DECODED_SAMPLES}: caps the
 * decoded working set (frames x channels) of the on-demand cleanup. At 4
 * bytes per decoded sample plus the 16-bit WAV output this keeps the peak
 * allocation near ~400 MB, inside a phone WebView's budget.
 */
export const MOBILE_MAX_CLEANUP_DECODED_SAMPLES = 64 * 1024 * 1024;

/**
 * Mobile counterpart of {@link MAX_AUDIO_CLEANUP_SECONDS}. The cleanup DSP
 * runs on the main thread of a WebView that the OS may terminate when it
 * stays busy too long, so mobile gets a shorter duration ceiling.
 */
export const MOBILE_MAX_AUDIO_CLEANUP_SECONDS = 45 * 60;

/** PCM buffer flush threshold for WAV desktop recordings. */
export const PCM_FLUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Desktop MediaRecorder chunk buffer flush threshold before writing to disk. */
export const DESKTOP_FLUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Common MIME type prefix for audio formats. */
export const MIME_TYPE_AUDIO_PREFIX = 'audio/';

/** Default audio sample rate in Hz. */
export const DEFAULT_SAMPLE_RATE = 44100;

/**
 * A channel whose RMS is at or below this level (dBFS) is treated as
 * silent by the post-recording lopsided-stereo check. -60 dBFS is deep
 * below usable speech, so a channel this quiet carries no real content.
 */
export const SILENT_CHANNEL_FLOOR_DB = -60;

/**
 * Minimum gap, in dB, between the loud and quiet channels of a stereo
 * recording before the quiet one is reported as silent. Keeps a merely
 * off-center mix (both channels present) from triggering the prompt.
 */
export const SILENT_CHANNEL_MIN_GAP_DB = 40;

/**
 * Minimum peak-window level that counts as real audio on the channel we
 * propose to keep. This prevents a nearly empty recording with tiny device
 * noise just above the silence floor from producing a conversion prompt.
 */
export const SILENT_CHANNEL_MIN_AUDIO_DB = -45;

/**
 * Window length used by silent-channel analysis. Peak window RMS is used
 * instead of whole-file RMS so a short but real sound on one channel is not
 * diluted by minutes of silence and incorrectly discarded.
 */
export const SILENT_CHANNEL_ANALYSIS_WINDOW_SECONDS = 0.25;

/**
 * Maximum recording duration, in seconds, that the post-save
 * silent-channel check will decode. A full decode is the only way to
 * read per-channel levels; capping it keeps a long session from paying
 * that cost on every save. Longer files are skipped silently.
 */
export const SILENT_CHANNEL_MAX_DECODE_SECONDS = 20 * 60;

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

/**
 * Step of the player volume sliders, shared by the embedded control row and
 * the status-bar playback controls so both offer the same granularity.
 */
export const PLAYER_VOLUME_SLIDER_STEP = 0.05;

/**
 * Obsidian icon names for the shared player transport, used by both the
 * embedded control row and the status-bar playback controls so the two
 * surfaces stay visually consistent and no icon name is duplicated inline.
 */
export const PLAYER_ICONS = {
	play: 'play',
	pause: 'pause',
	stop: 'square',
	skipBack: 'rewind',
	skipForward: 'fast-forward',
	volume: 'volume-2',
	muted: 'volume-x',
	loop: 'repeat',
	addBookmark: 'bookmark-plus',
	addChapter: 'list-plus',
	previousChapter: 'chevron-first',
	nextChapter: 'chevron-last',
	copyLink: 'link',
} as const;

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
	GEMINI: 'gemini',
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
 * Conservative lower bound on real-world audio bitrate, in bytes per second
 * (~8 kbps), used only as a cheap proof that a small file is short enough to
 * send to a duration-capped provider whole without decoding it to measure its
 * true length. Set well below any practical speech codec so a file that passes
 * the proof (bytes <= cap * this) genuinely cannot exceed the duration cap;
 * larger files fall through to the decode path, which measures exactly.
 */
export const MIN_AUDIO_BYTES_PER_SEC = 1000;

/**
 * Default upload size limit per request, in megabytes, for the Whisper
 * API. OpenAI's limit is 25 MB; chunks are sized to stay under it.
 */
export const DEFAULT_TRANSCRIBE_CHUNK_MB = 24;

/**
 * Default endpoint of the OpenAI account. One account is one endpoint whatever
 * the engines behind it are asked to do, so the Whisper API and the OpenAI chat
 * models are reached through this one value rather than through a copy each.
 */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Default Whisper API model id. */
export const DEFAULT_WHISPER_API_MODEL = 'whisper-1';

/**
 * Generation of the shipped model catalogues. Raised whenever a seed list
 * gains ids worth offering, which tops up the saved lists once: a list stays
 * the user's to edit, so an id deleted after that stays deleted.
 */
export const MODEL_SEED_GENERATION = 2;

/**
 * Seed model ids for the OpenAI-compatible Whisper API. They populate the
 * model picker on first run and can be extended with custom ids in settings.
 * All return `verbose_json` with segment timestamps, which the provider
 * relies on: `whisper-1` is OpenAI's; the `*-v3*` ids are served by Groq and
 * other compatible hosts. (OpenAI's newer `gpt-4o-transcribe`,
 * `gpt-4o-mini-transcribe`, and `gpt-4o-transcribe-diarize` models are
 * omitted: none of them return `verbose_json` - the diarize variant has its
 * own `diarized_json` format without segment timecodes - so they are
 * incompatible with the timed output the plugin requests. As of July 2026,
 * `whisper-1` remains OpenAI's only model that supports it.)
 */
export const WHISPER_API_MODEL_SUGGESTIONS = [
	'whisper-1',
	'whisper-large-v3',
	'whisper-large-v3-turbo',
	'distil-whisper-large-v3-en',
];

/** Where to find the model list for the configured Whisper API host. */
export const WHISPER_API_MODELS_DOC_URL =
	'https://developers.openai.com/api/docs/guides/speech-to-text';

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
 * Flux family (`flux-general-en`, `flux-general-multi`) is omitted - even
 * after gaining word-level timestamps in July 2026 it remains a streaming
 * conversational model for voice agents, not part of the pre-recorded API
 * this plugin uses. See {@link DEEPGRAM_MODELS_DOC_URL} for the
 * authoritative, current list.
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

/**
 * Default Gemini API base URL. The provider appends `/v1beta/...` for model
 * and file operations and `/upload/v1beta/files` for the File API upload, so
 * this value carries no version segment.
 */
export const DEFAULT_GEMINI_BASE_URL =
	'https://generativelanguage.googleapis.com';

/**
 * Default Gemini transcription model id. Moved from `gemini-2.5-flash` to
 * `gemini-3.5-flash` (GA May 2026): the strongest Flash generation, accepts
 * audio, and priced in the same tier as the 2.5 Flash it replaces.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Seed Gemini model ids for the model picker on first run; the list is
 * user-editable. Flash models are cheaper and fast enough for transcription;
 * the GA 3.x generation (all accept audio) leads the list, with the 2.5
 * generation kept while it stays in the catalog. Deliberately excluded as of
 * July 2026: `gemini-3.5-pro` (announced but not released - no public API
 * id), `gemini-3.1-pro-preview` (preview, not GA), the Live and TTS models
 * (live audio-to-audio dialog and speech synthesis, not file transcription),
 * and `gemini-3.5-flash-cyber` (restricted-access pilot). See
 * {@link GEMINI_MODELS_DOC_URL} for the authoritative, current list.
 */
export const GEMINI_MODEL_SUGGESTIONS = [
	'gemini-3.6-flash',
	'gemini-3.5-flash',
	'gemini-3.5-flash-lite',
	'gemini-2.5-flash',
	'gemini-2.5-pro',
	'gemini-2.5-flash-lite',
	'gemini-2.0-flash',
];

/** Authoritative, current list of Gemini models. */
export const GEMINI_MODELS_DOC_URL =
	'https://ai.google.dev/gemini-api/docs/models';

/**
 * Hard per-request ceiling for Gemini, in bytes (2 GB - the File API limit).
 * Gemini transcribes a whole file in one request with consistent speaker
 * labels, so files under this are sent in one piece instead of chunked.
 */
export const GEMINI_MAX_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Container MIME types the Gemini File API accepts for audio directly. Any
 * other container (notably `audio/webm` and `audio/mp4`/m4a, which the plugin
 * can record) is decoded to 16 kHz mono WAV before upload.
 */
export const GEMINI_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
	`${MIME_TYPE_AUDIO_PREFIX}wav`,
	`${MIME_TYPE_AUDIO_PREFIX}mpeg`,
	`${MIME_TYPE_AUDIO_PREFIX}aac`,
	`${MIME_TYPE_AUDIO_PREFIX}ogg`,
	`${MIME_TYPE_AUDIO_PREFIX}flac`,
	`${MIME_TYPE_AUDIO_PREFIX}aiff`,
]);

/** Header carrying the Gemini API key on every request. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key';

/** Interval between Gemini File API status polls, in milliseconds. */
export const GEMINI_FILE_POLL_INTERVAL_MS = 1500;

/**
 * Floor for the time to wait for an uploaded Gemini file to leave the
 * PROCESSING state, in milliseconds. Small files are usually ready within
 * this; larger uploads scale up from here (see {@link GEMINI_FILE_MAX_WAIT_MS}).
 */
export const GEMINI_FILE_MIN_WAIT_MS = 2 * 60_000;

/**
 * Ceiling for the processing wait, in milliseconds. A near-2 GB upload can
 * take several minutes to become ACTIVE, so the wait scales with size up to
 * this cap rather than aborting a healthy large file at the floor.
 */
export const GEMINI_FILE_MAX_WAIT_MS = 20 * 60_000;

/**
 * Bytes of upload per millisecond added to {@link GEMINI_FILE_MIN_WAIT_MS} when
 * scaling the processing wait with file size. Deliberately conservative so a
 * large file is not aborted prematurely; the wait is still capped at
 * {@link GEMINI_FILE_MAX_WAIT_MS}.
 */
export const GEMINI_FILE_WAIT_BYTES_PER_MS = 2048;

/**
 * Thinking budget that turns Gemini's chain-of-thought off. Transcription and
 * transcript post-processing are deterministic and gain nothing from thinking,
 * while thinking tokens otherwise consume the output-token budget and can
 * truncate or empty the result. Flash-family models accept 0; Gemini 2.5 Pro
 * cannot disable thinking, see {@link GEMINI_PRO_MIN_THINKING_BUDGET}.
 */
export const GEMINI_THINKING_BUDGET_OFF = 0;

/**
 * Minimum thinking budget for Gemini 2.5 Pro, which cannot disable thinking and
 * rejects a budget of 0. Applied so a Pro selection still caps thinking at the
 * floor instead of letting the dynamic budget consume the output budget.
 */
export const GEMINI_PRO_MIN_THINKING_BUDGET = 128;

/**
 * Floor for the Gemini transcription `generateContent` timeout, in
 * milliseconds. Inference time scales with audio duration, which the upload
 * byte size underestimates for compressed accepted containers (mp3, aac, ogg,
 * flac); this floor keeps a long compressed recording from timing out while
 * Gemini is still transcribing. The size-scaled upload budget still applies
 * above it (capped at {@link TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS}).
 */
export const GEMINI_GENERATE_MIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Longest recording, in seconds, that Gemini transcribes in a single
 * `generateContent` request. Beyond this the audio is split into parts that
 * are transcribed separately and stitched back onto the timeline: one request
 * for a long meeting would otherwise outlast the request timeout and risk
 * MAX_TOKENS truncation, since both inference time and the output transcript
 * grow with audio duration. Sized so each part finishes comfortably within
 * {@link GEMINI_GENERATE_MIN_TIMEOUT_MS}. Splitting resets Gemini's per-request
 * speaker numbering, so a diarized split surfaces a warning to the user.
 */
export const GEMINI_MAX_WHOLE_FILE_SECONDS = 15 * 60;

/**
 * Smallest half an adaptive subdivision may produce when a part overruns a
 * provider's output token limit. Output token count is not predictable from
 * audio duration (a dense, diarized stretch yields far more text than a sparse
 * one), so a part that truncates is retried as halves; this floor stops the
 * recursion once the pieces are short enough that a further split would cost
 * more requests than it saves, after which the part is reported as failed and
 * the surrounding parts are still kept.
 */
export const MIN_SUBDIVIDE_SECONDS = 60;

// Advanced two-pass transcription (LLM-driven context biasing)

/**
 * Default second-pass length safeguard for advanced two-pass transcription:
 * the second (context-biased) pass is kept only when its plain text is at
 * least this fraction of the first pass's length. A biased decode that came
 * back much shorter almost certainly dropped content (the over-correction
 * failure mode), so the run falls back to the baseline transcript.
 */
export const DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO = 0.8;

/** Smallest configurable second-pass length safeguard ratio. */
export const MIN_ADVANCED_SECOND_PASS_MIN_RATIO = 0.5;

/** Largest configurable second-pass length safeguard ratio. */
export const MAX_ADVANCED_SECOND_PASS_MIN_RATIO = 1;

/** Step of the second-pass length safeguard ratio input. */
export const ADVANCED_SECOND_PASS_RATIO_STEP = 0.05;

/**
 * LLM post-processing provider ids. The single source for the string values
 * used as the provider `id`, the settings discriminator, and the keys of the
 * provider label map, so the literals are never hand-typed across the codebase.
 * {@link LlmProviderId} is derived from these values. Mirrors
 * {@link TRANSCRIPTION_PROVIDER_IDS}.
 */
export const LLM_PROVIDER_IDS = {
	OPENAI_COMPATIBLE: 'openai-compatible',
	ANTHROPIC: 'anthropic',
	GEMINI: 'gemini',
} as const;

/**
 * Default OpenAI-compatible chat model for LLM post-processing. Moved from
 * `gpt-4o-mini` (dropped from the current catalog) to the GPT-5.6 flagship,
 * matching the Anthropic default, which is also that provider's flagship;
 * `gpt-5.6-terra` and `gpt-5.6-luna` stay in the seed list as the cheaper
 * picks.
 */
export const DEFAULT_LLM_OPENAI_MODEL = 'gpt-5.6-sol';

/** Default endpoint of the Anthropic account. */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/** Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Default Anthropic model for transcript post-processing. Kept at
 * `claude-opus-4-8` after the July 2026 catalog review: it is still a current
 * model and the provider's recommended default, while `claude-fable-5` above
 * it is priced for the most demanding work rather than everyday cleanup.
 */
export const DEFAULT_LLM_ANTHROPIC_MODEL = 'claude-opus-4-8';

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
 * Granularity of the LLM output token budget: one token.
 *
 * A declared step is the value space of the setting, not a convenience for the
 * stepper arrows: the settings framework offers exactly `min + n * step` and
 * refuses everything between. A token budget is meaningful at every integer,
 * and the numbers a user reaches for come from a model's own documentation
 * (8000, 16000, 32000), so anything coarser would refuse most of them - a
 * 512-token grid excluded the ceiling itself.
 */
export const LLM_MAX_TOKENS_STEP = 1;

/**
 * Seed OpenAI chat model ids for the LLM model picker on first run; the list
 * is user-editable. The GPT-5.6 family (released July 2026) is the current
 * text-model catalog: `gpt-5.6-sol` is the flagship (alias `gpt-5.6`),
 * `gpt-5.6-terra` balances intelligence and price, and `gpt-5.6-luna` is the
 * cheapest for high volume. The previous `gpt-4o*` / `gpt-4.1*` / `o4-mini`
 * seeds were removed: they no longer appear in the current catalog (`o4-mini`
 * was retired on February 13, 2026, and the 4.x block left the text-model
 * pages with the GPT-5.6 launch), though ids a user saved keep working while
 * the API still serves them. See {@link OPENAI_MODELS_DOC_URL} for the
 * current list.
 */
export const LLM_OPENAI_MODEL_SUGGESTIONS = [
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
];

/**
 * Seed Anthropic model ids for the LLM model picker on first run; the list is
 * user-editable. `claude-sonnet-5` (GA June 2026) replaces
 * `claude-sonnet-4-6`, which the catalog moved to the legacy tier;
 * `claude-fable-5` is the most capable current model but is priced above the
 * Opus tier, so it is listed after the everyday picks. See
 * {@link ANTHROPIC_MODELS_DOC_URL} for the current list.
 */
export const LLM_ANTHROPIC_MODEL_SUGGESTIONS = [
	'claude-opus-4-8',
	'claude-sonnet-5',
	'claude-haiku-4-5',
	'claude-fable-5',
];

/** Where to find the OpenAI model catalog. */
export const OPENAI_MODELS_DOC_URL =
	'https://developers.openai.com/api/docs/models';

/** Where to find the Anthropic (Claude) model catalog. */
export const ANTHROPIC_MODELS_DOC_URL =
	'https://platform.claude.com/docs/en/about-claude/models/overview';

/**
 * Default editable system prompt for the cleanup task. The language clause is
 * appended automatically at request time (see {@link cleanupLanguageClause}),
 * so this base text carries no language directive.
 */
export const DEFAULT_LLM_CLEANUP_PROMPT =
	'You are an expert transcription editor. You are given a raw, ' +
	'machine-generated transcript. Correct punctuation, capitalization, ' +
	'and obvious speech-to-text errors; insert sensible paragraph breaks; ' +
	'and remove filler artifacts only when they add no meaning. Do NOT ' +
	'summarize, translate, paraphrase, add, or omit content - preserve ' +
	"the speaker's exact wording and meaning. Preserve any speaker labels " +
	'and timestamps exactly as they appear, keeping each on its original ' +
	'line. Return only the corrected transcript with no preamble.';

/**
 * Default editable system prompt for the summary task. The language clause is
 * appended automatically at request time (see {@link summaryLanguageClause}),
 * so this base text carries no language directive.
 */
export const DEFAULT_LLM_SUMMARY_PROMPT =
	'You are an expert analyst. Summarize the following transcript into a ' +
	'concise set of key points and any action items, as Markdown bullet ' +
	'lists under short headings. Be faithful to the content and do not ' +
	'invent details. Return only the summary with no preamble.';

/**
 * Default editable instruction for the custom task. Unlike cleanup and
 * summary, the custom instruction is sent verbatim with no language clause, so
 * the user controls every directive including language.
 */
export const DEFAULT_LLM_CUSTOM_INSTRUCTION =
	'Rewrite the following transcript as clean, well-structured Markdown ' +
	'notes. Preserve the original language and meaning, and return only the ' +
	'result with no preamble.';

/**
 * Fixed id of the built-in chapter guidance profile seeded on first run. It is
 * a stable literal (not a random uuid) so the default selection in
 * DEFAULT_SETTINGS is deterministic and the profile stays identifiable after a
 * settings reload.
 */
export const DEFAULT_CHAPTER_PROMPT_PROFILE_ID = 'default';

/**
 * Default chapter-splitting guidance, seeded as the first (selected) chapter
 * prompt profile and freely editable. It steers HOW the recording is divided;
 * the strict JSON response contract and the timecode rules live in the fixed
 * base prompt (see {@link buildChapterPrompt}) and are never user-editable, so
 * a customized or added profile cannot break response parsing.
 */
export const DEFAULT_CHAPTER_PROMPT =
	'Divide the recording at the major topic shifts so each chapter covers ' +
	'one coherent subject. Avoid splitting a single discussion across ' +
	'chapters, keep chapter lengths reasonably balanced, and title each ' +
	'chapter with the concrete subject discussed rather than a generic label.';

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
 * large but healthy upload is never aborted prematurely. Used as the
 * fallback ceiling when no per-request cap is supplied; the user-facing cap
 * comes from {@link DEFAULT_TRANSCRIPTION_TIMEOUT_MINUTES} via settings.
 */
export const TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;

/**
 * Default per-request transcription timeout, in minutes. A single network
 * request (one part of a multi-part job, or a whole-file upload) that runs
 * longer than this is aborted and reported, so a hung endpoint or a stalled
 * upload fails the part instead of stalling the whole run indefinitely. The
 * size-scaled timeout still applies underneath; this value caps it. The
 * default matches the Gemini generate floor so it is generous enough for a
 * healthy long request yet bounds a genuine hang.
 */
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MINUTES = 10;

/** Smallest configurable per-request transcription timeout, in minutes. */
export const MIN_TRANSCRIPTION_TIMEOUT_MINUTES = 1;

/** Largest configurable per-request transcription timeout, in minutes. */
export const MAX_TRANSCRIPTION_TIMEOUT_MINUTES = 60;

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

// Audio cleanup (on-demand DSP)

/** Default high-pass filter cutoff in Hz (removes low rumble). */
export const DEFAULT_CLEANUP_HIGHPASS_HZ = 80;

/** Minimum configurable high-pass cutoff in Hz. */
export const MIN_CLEANUP_HIGHPASS_HZ = 20;

/** Maximum configurable high-pass cutoff in Hz. */
export const MAX_CLEANUP_HIGHPASS_HZ = 300;

/** Default noise-gate threshold in dBFS. */
export const DEFAULT_CLEANUP_GATE_THRESHOLD_DB = -50;

/** Minimum configurable noise-gate threshold in dBFS. */
export const MIN_CLEANUP_GATE_THRESHOLD_DB = -80;

/** Maximum configurable noise-gate threshold in dBFS. */
export const MAX_CLEANUP_GATE_THRESHOLD_DB = -20;

/** Default makeup gain in dB applied after leveling compression. */
export const DEFAULT_CLEANUP_LEVELING_MAKEUP_DB = 6;

/** Minimum configurable leveling makeup gain in dB. */
export const MIN_CLEANUP_LEVELING_MAKEUP_DB = 0;

/** Maximum configurable leveling makeup gain in dB. */
export const MAX_CLEANUP_LEVELING_MAKEUP_DB = 24;

/**
 * Slider step (Hz) for the high-pass cutoff, shared by the cleanup
 * dialog and the settings tab so the two surfaces cannot drift apart.
 */
export const CLEANUP_HIGHPASS_STEP_HZ = 5;

/** Slider step (dBFS) for the noise-gate threshold in the cleanup UI. */
export const CLEANUP_GATE_STEP_DB = 1;

/** Slider step (dB) for the leveling makeup gain in the cleanup UI. */
export const CLEANUP_LEVELING_STEP_DB = 1;

/**
 * Upper bound, in bytes, on the encoded size of a file the on-demand
 * audio cleanup will read and decode. Checked before decoding so a
 * pathologically large file is rejected up front instead of allocating
 * the whole decoded buffer (and a larger Float32 working copy) in the
 * renderer. Bound to the player's decode ceiling so the two stay in
 * lockstep.
 */
export const MAX_AUDIO_CLEANUP_BYTES = WAVEFORM_MAX_DECODE_BYTES;

/**
 * Upper bound, in seconds, on the duration of a file the on-demand audio
 * cleanup will process. The noise gate and WAV encoding run as a single
 * synchronous pass on the main thread, so a very long file would freeze
 * the UI; above this the action asks the user to split the file first.
 */
export const MAX_AUDIO_CLEANUP_SECONDS = 2 * 60 * 60;

/**
 * Upper bound on the total decoded sample count (frames x channels) the
 * on-demand cleanup will process. Where {@link MAX_AUDIO_CLEANUP_BYTES}
 * bounds the on-disk size, this bounds the decoded working set. Cleanup now
 * processes the signal in time segments (see {@link CLEANUP_SEGMENT_SECONDS}),
 * so the gate and the OfflineAudioContext only ever hold one segment at a
 * time; the lasting full-size allocations are just the decoded buffer (4
 * bytes/sample) and the interleaved 16-bit WAV output (2 bytes/sample). At
 * this cap that peak stays near ~1.6 GB regardless of how many DSP stages run,
 * which lets a ~45-minute stereo recording be cleaned up in memory without the
 * old "split into parts first" detour. A heavily compressed file can be small
 * on disk yet decode to a multi-gigabyte buffer the byte guard alone would not
 * catch, so the count is checked right after decoding, before the Float32
 * channels are materialized, refusing an oversized file with a clear message
 * instead of an out-of-memory error.
 */
export const MAX_AUDIO_CLEANUP_DECODED_SAMPLES = 256 * 1024 * 1024;

/**
 * Length, in seconds, of one cleanup processing segment. The signal is gated
 * and rendered one segment at a time so peak memory does not scale with the
 * recording length. Long enough that the per-segment OfflineAudioContext setup
 * cost is negligible, short enough that one segment's working set stays small.
 */
export const CLEANUP_SEGMENT_SECONDS = 120;

/**
 * Warm-up overlap, in seconds, prepended to each cleanup segment (except the
 * first) and then discarded. The high-pass filter, compressor, and gate are
 * stateful; processing a short lead-in lets their envelopes settle to the same
 * place they would reach in a single continuous pass, so segment boundaries
 * leave no audible click or level jump. Comfortably longer than the
 * compressor's release time, so the dynamics fully re-converge before the kept
 * region begins.
 */
export const CLEANUP_WARMUP_SECONDS = 3;

// Actions

/** Menu section identifier grouping all plugin context-menu items. */
export const AAR_MENU_SECTION = 'aar';

/**
 * Command ids for every palette-registered action. The transcribe id
 * predates the action registry and is kept verbatim so user-assigned
 * hotkeys survive.
 */
export const COMMAND_IDS = {
	startStopRecording: 'start-stop-recording',
	pauseResumeRecording: 'pause-resume-recording',
	addRecordingMarker: 'add-recording-marker',
	addRecordingBookmark: 'add-recording-bookmark',
	addRecordingChapter: 'add-recording-chapter',
	selectAudioInputDevice: 'select-audio-input-device',
	audioFileInfo: 'audio-file-info',
	convertAudioFormat: 'convert-audio-format',
	splitAudio: 'split-audio-into-parts',
	cleanupAudio: 'clean-up-audio',
	transcribeAudio: 'transcribe-active-audio',
	renameSpeakers: 'rename-transcript-speakers',
	generateChapters: 'generate-chapters-from-transcript',
	deleteRecording: 'delete-recording',
} as const;
