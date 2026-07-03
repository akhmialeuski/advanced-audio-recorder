/**
 * Unit tests for recording-start error descriptions.
 * @module tests/unit/recordingErrors.test
 */

import { describeRecordingError } from 'src/recording/recordingErrors';

describe('describeRecordingError', () => {
	it.each([
		[
			'NotAllowedError',
			'Microphone access denied. Please grant permission in browser settings.',
		],
		[
			'NotFoundError',
			'No microphone found. Please connect an audio input device.',
		],
		['NotReadableError', 'Microphone is in use by another application.'],
	])('maps DOMException %s to specific guidance', (name, expected) => {
		expect(describeRecordingError(new DOMException('denied', name))).toBe(
			expected,
		);
	});

	it('falls back to the DOMException message for other names', () => {
		expect(
			describeRecordingError(new DOMException('boom', 'AbortError')),
		).toBe('Recording error: boom');
	});

	it('uses the Error message for plain errors', () => {
		expect(describeRecordingError(new Error('device lost'))).toBe(
			'Error starting recording: device lost',
		);
	});

	it('stringifies non-Error values', () => {
		expect(describeRecordingError('nope')).toBe(
			'Error starting recording: nope',
		);
	});
});
