/**
 * Custom error classes for the Audio Recorder plugin.
 * @module errors
 */

import { PLUGIN_LOG_PREFIX } from './constants';

/**
 * Base class for plugin errors. Not exported: nothing outside this module
 * catches the base type, and the concrete errors below carry the meaning
 * callers actually match on.
 */
class AudioRecorderError extends Error {
	constructor(message: string) {
		super(`${PLUGIN_LOG_PREFIX} ${message}`);
		this.name = 'AudioRecorderError';
	}
}

/**
 * Error thrown when audio stream acquisition fails.
 */
export class AudioStreamError extends AudioRecorderError {
	constructor(
		public readonly originalError: Error,
		public readonly deviceId?: string,
	) {
		const message = deviceId
			? `Failed to access audio device "${deviceId}". ` +
				`The device may be disconnected, in use by another application, or its ID may have changed. ` +
				`Please verify the device in plugin settings. Original error: ${originalError.message}`
			: `Failed to access audio device. Original error: ${originalError.message}`;
		super(message);
		this.name = 'AudioStreamError';
	}
}

/**
 * Error thrown when settings validation fails.
 */
export class SettingsValidationError extends AudioRecorderError {
	constructor(
		public readonly field: string,
		public readonly reason: string,
	) {
		super(`Invalid setting "${field}": ${reason}`);
		this.name = 'SettingsValidationError';
	}
}

/**
 * Error thrown when offline audio encoding fails.
 */
export class EncodingError extends AudioRecorderError {
	constructor(
		message: string,
		public readonly format: string,
		public readonly originalError?: unknown,
	) {
		super(`Encoding to ${format} failed: ${message}`);
		this.name = 'EncodingError';
	}
}
