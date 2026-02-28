/**
 * Settings interface and default values for the Audio Recorder plugin.
 * @module settings/Settings
 */

import { SettingsValidationError } from '../errors';
import {
	FORMAT_WEBM,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
} from '../recording/AudioCapabilityDetector';
import { getDefaultDeviceId } from '../utils/DeviceUtils';

/**
 * Output mode for multi-track recordings.
 */
export type OutputMode = 'single' | 'multiple';

/**
 * Track audio sources mapping (track number -> device ID).
 */
export interface AudioSource {
	/** Selected device ID for the track. */
	deviceId: string;
}

/**
 * Track audio sources mapping (track number -> audio source).
 */
export type TrackAudioSources = Map<number, AudioSource>;

/**
 * Serialized track audio sources mapping (track number -> device ID).
 */
export type TrackAudioSourcesRecord = Record<number, string | AudioSource>;

/**
 * Plugin settings interface.
 */
export interface AudioRecorderSettings {
	/** Audio recording format (e.g., 'webm', 'ogg') */
	recordingFormat: string;
	/** Folder path to save recordings */
	saveFolder: string;
	/** Save recordings next to the currently active note */
	saveNearActiveFile: boolean;
	/** Optional subfolder (relative to active file directory) */
	activeFileSubfolder: string;
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
	recordingFormat: FORMAT_WEBM,
	saveFolder: '',
	saveNearActiveFile: false,
	activeFileSubfolder: '',
	filePrefix: 'recording',
	startStopHotkey: '',
	pauseHotkey: '',
	resumeHotkey: '',
	audioDeviceId: '',
	sampleRate: DEFAULT_SAMPLE_RATE,
	bitrate: DEFAULT_BITRATE,
	enableMultiTrack: false,
	maxTracks: 2,
	outputMode: 'single',
	useSourceNamesForTracks: true,
	trackAudioSources: new Map(),
	debug: false,
};

export interface AudioRecorderSettingsInput extends Partial<
	Omit<AudioRecorderSettings, 'trackAudioSources'>
> {
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord;
}

export interface SerializedAudioRecorderSettings extends Omit<
	AudioRecorderSettings,
	'trackAudioSources'
> {
	trackAudioSources: Record<number, string>;
}

/**
 * Normalizes track audio sources into a Map.
 */
export function normalizeTrackAudioSources(
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord,
): TrackAudioSources {
	if (!trackAudioSources) {
		return new Map();
	}

	if (trackAudioSources instanceof Map) {
		return new Map(trackAudioSources);
	}

	const sources = new Map<number, AudioSource>();
	for (const [key, value] of Object.entries(trackAudioSources)) {
		const trackNumber = Number(key);
		if (Number.isNaN(trackNumber)) {
			continue;
		}
		if (typeof value === 'string') {
			sources.set(trackNumber, { deviceId: value });
			continue;
		}
		if (value && typeof value === 'object' && 'deviceId' in value) {
			const deviceId = (value as { deviceId?: unknown }).deviceId;
			sources.set(trackNumber, {
				deviceId: typeof deviceId === 'string' ? deviceId : '',
			});
		}
	}
	return sources;
}

/**
 * Serializes track audio sources into a plain object.
 */
export function serializeTrackAudioSources(
	trackAudioSources: TrackAudioSources,
): Record<number, string> {
	const serialized: Record<number, string> = {};
	for (const [trackNumber, source] of trackAudioSources.entries()) {
		serialized[trackNumber] = source.deviceId;
	}
	return serialized;
}

/**
 * Serializes settings for persistence.
 */
export function serializeSettings(
	settings: AudioRecorderSettings,
): SerializedAudioRecorderSettings {
	return {
		...settings,
		trackAudioSources: serializeTrackAudioSources(
			settings.trackAudioSources,
		),
	};
}

/**
 * Merges user settings with defaults.
 * @param userSettings - Partial user settings
 * @returns Complete settings object
 */
export function mergeSettings(
	userSettings: AudioRecorderSettingsInput = {},
): AudioRecorderSettings {
	return {
		...DEFAULT_SETTINGS,
		...userSettings,
		trackAudioSources: normalizeTrackAudioSources(
			userSettings.trackAudioSources,
		),
	};
}

/**
 * Async version of mergeSettings that detects and sets the default audio device
 * if no device is configured. This should be called during plugin initialization
 * to ensure a default device is selected for first-time users.
 * @param userSettings - Partial user settings from storage
 * @returns Complete settings object with default device if needed
 */
export async function mergeSettingsAsync(
	userSettings: AudioRecorderSettingsInput = {},
): Promise<AudioRecorderSettings> {
	const merged = mergeSettings(userSettings);

	// Auto-select default device if no device is configured
	if (!merged.audioDeviceId || merged.audioDeviceId.trim() === '') {
		const defaultDeviceId = await getDefaultDeviceId();
		if (defaultDeviceId) {
			merged.audioDeviceId = defaultDeviceId;
		}
	}

	return merged;
}

/**
 * Validates audio recorder settings before use.
 * @param settings - Settings to validate
 * @throws SettingsValidationError if any setting is invalid
 */
export function validateSettings(settings: AudioRecorderSettings): void {
	if (!settings.audioDeviceId || settings.audioDeviceId.trim() === '') {
		throw new SettingsValidationError(
			'audioDeviceId',
			'Audio device is not selected. Please select an audio input device in plugin settings.',
		);
	}

	if (!settings.sampleRate || settings.sampleRate <= 0) {
		throw new SettingsValidationError(
			'sampleRate',
			'Sample rate must be a positive number.',
		);
	}

	if (!settings.recordingFormat || settings.recordingFormat.trim() === '') {
		throw new SettingsValidationError(
			'recordingFormat',
			'Recording format is not selected.',
		);
	}

	if (settings.enableMultiTrack) {
		const trackCount = settings.trackAudioSources.size;
		if (trackCount === 0) {
			throw new SettingsValidationError(
				'trackAudioSources',
				'Multi-track recording is enabled but no audio sources are selected.',
			);
		}
		for (const [trackNum, source] of settings.trackAudioSources.entries()) {
			if (!source.deviceId || source.deviceId.trim() === '') {
				throw new SettingsValidationError(
					`trackAudioSources[${trackNum}]`,
					`Track ${trackNum} has no audio source selected.`,
				);
			}
		}
	}
}
