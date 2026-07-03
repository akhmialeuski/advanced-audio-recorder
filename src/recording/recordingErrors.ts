/**
 * User-facing descriptions of recording-start failures.
 * @module recording/recordingErrors
 */

/**
 * Maps a recording-start failure onto a user-friendly message. Media
 * capture failures surface as DOMExceptions with well-known names; those
 * get specific guidance, everything else falls back to the error text.
 * @param error - The thrown value from startRecording
 * @returns Message suitable for a Notice
 */
export function describeRecordingError(error: unknown): string {
	if (error instanceof DOMException) {
		if (error.name === 'NotAllowedError') {
			return 'Microphone access denied. Please grant permission in browser settings.';
		}
		if (error.name === 'NotFoundError') {
			return 'No microphone found. Please connect an audio input device.';
		}
		if (error.name === 'NotReadableError') {
			return 'Microphone is in use by another application.';
		}
		return `Recording error: ${error.message}`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return `Error starting recording: ${message}`;
}
