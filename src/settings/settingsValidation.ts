/**
 * Recording-path settings validation. Player-window settings deliberately
 * stay out of here (see player/playerSettings.ts): they are unrelated to
 * recording and must never throw on the recording path.
 * @module settings/settingsValidation
 */

import { SettingsValidationError } from '../errors';
import {
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	SPLIT_PART_SUFFIX_PATTERN,
	SPLIT_PART_SUFFIX_RULE_TEXT,
} from '../constants';
import type { AudioRecorderSettings } from './settingsSchema';

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

	if (!SPLIT_PART_SUFFIX_PATTERN.test(settings.splitPartSuffix)) {
		throw new SettingsValidationError(
			'splitPartSuffix',
			SPLIT_PART_SUFFIX_RULE_TEXT,
		);
	}

	// Validated regardless of autoSplitEnabled: the value is also the
	// default part duration for manual splitting. Runtime paths still
	// clamp/sanitize defensively (clampSplitMinutes, sanitizePartSuffix)
	// because validateSettings is not on the production load path.
	if (
		!Number.isInteger(settings.splitChunkMinutes) ||
		settings.splitChunkMinutes < MIN_SPLIT_CHUNK_MINUTES ||
		settings.splitChunkMinutes > MAX_SPLIT_CHUNK_MINUTES
	) {
		throw new SettingsValidationError(
			'splitChunkMinutes',
			`Part duration must be an integer between ${String(MIN_SPLIT_CHUNK_MINUTES)} and ${String(MAX_SPLIT_CHUNK_MINUTES)} minutes.`,
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
