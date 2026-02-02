/**
 * Settings interface and default values for the Audio Recorder plugin.
 * @module settings/Settings
 */

/**
 * Output mode for multi-track recordings.
 */
export type OutputMode = 'single' | 'multiple';

/**
 * Track audio sources mapping (track number -> device ID).
 */
export type TrackAudioSources = Record<number, string>;

/**
 * Plugin settings interface.
 */
export interface AudioRecorderSettings {
	/** Audio recording format (e.g., 'webm', 'ogg') */
	recordingFormat: string;
	/** Folder path to save recordings */
	saveFolder: string;
	/** Prefix for recorded file names */
	filePrefix: string;
	/** Hotkey for start/stop recording */
	startStopHotkey: string;
	/** Hotkey for pause */
	pauseHotkey: string;
	/** Hotkey for resume */
	resumeHotkey: string;
	/** Selected audio device ID */
	audioDeviceId: string;
	/** Audio sample rate in Hz */
	sampleRate: number;
	/** Audio bitrate in bps */
	bitrate: number;
	/** Enable multi-track recording */
	enableMultiTrack: boolean;
	/** Maximum number of tracks */
	maxTracks: number;
	/** Output mode for multi-track recordings */
	outputMode: OutputMode;
	/** Use source names for track file names */
	useSourceNamesForTracks: boolean;
	/** Audio source mapping for each track */
	trackAudioSources: TrackAudioSources;
	/** Enable debug logging */
	debug: boolean;
}

/**
 * Default plugin settings.
 */
export const DEFAULT_SETTINGS: AudioRecorderSettings = {
	recordingFormat: 'webm',
	saveFolder: '',
	filePrefix: 'recording',
	startStopHotkey: '',
	pauseHotkey: '',
	resumeHotkey: '',
	audioDeviceId: '',
	sampleRate: 44100,
	bitrate: 128000,
	enableMultiTrack: false,
	maxTracks: 2,
	outputMode: 'single',
	useSourceNamesForTracks: true,
	trackAudioSources: {},
	debug: false,
};

/**
 * Merges user settings with defaults.
 * @param userSettings - Partial user settings
 * @returns Complete settings object
 */
export function mergeSettings(
	userSettings: Partial<AudioRecorderSettings>,
): AudioRecorderSettings {
	return { ...DEFAULT_SETTINGS, ...userSettings };
}
