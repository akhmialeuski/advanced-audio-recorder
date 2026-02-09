/**
 * Debug logging utility for the Audio Recorder plugin.
 * @module utils/DebugLogger
 */

import type { AudioRecorderSettings } from '../settings/Settings';

/**
 * DebugLogger provides conditional logging based on settings.debug flag.
 */
export class DebugLogger {
	private enabled: boolean;

	constructor(settings: AudioRecorderSettings) {
		this.enabled = settings.debug;
	}

	/**
	 * Updates the debug enabled state.
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.enabled = settings.debug;
	}

	/**
	 * Logs the selected MIME type for recording.
	 */
	logMimeType(mimeType: string): void {
		if (!this.enabled) return;
		console.debug('[AudioRecorder] Selected MIME type:', mimeType);
	}

	/**
	 * Logs available audio input devices.
	 */
	logDevices(devices: MediaDeviceInfo[]): void {
		if (!this.enabled) return;
		console.debug(
			'[AudioRecorder] Available audio devices:',
			devices.map((d) => ({ id: d.deviceId, label: d.label })),
		);
	}

	/**
	 * Logs the size of a received audio chunk.
	 */
	logChunkSize(trackIndex: number, size: number): void {
		if (!this.enabled) return;
		console.debug(
			`[AudioRecorder] Track ${String(trackIndex)} chunk size: ${String(size)} bytes`,
		);
	}

	/**
	 * Logs recording duration and estimated memory usage.
	 */
	logRecordingStats(durationMs: number, totalChunks: number): void {
		if (!this.enabled) return;
		const durationSec = (durationMs / 1000).toFixed(1);
		console.debug(
			`[AudioRecorder] Recording stats: ${durationSec}s, ${String(totalChunks)} chunks`,
		);
	}

	/**
	 * Logs generic debug information.
	 */
	log(message: string, ...args: unknown[]): void {
		if (!this.enabled) return;
		console.debug(`[AudioRecorder] ${message}`, ...args);
	}
}
