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
export const DEFAULT_PLAYER_WAVEFORM_HEIGHT = 48;

/** Seconds skipped by the player's skip-forward/back buttons. */
export const DEFAULT_PLAYER_SKIP_SECONDS = 10;

/** Playback rate applied to new players. */
export const DEFAULT_PLAYER_PLAYBACK_RATE = 1;

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
