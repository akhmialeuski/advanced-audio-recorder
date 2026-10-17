/**
 * Tests for the one shape every step that can refuse answers with: telling a
 * refusal from a value, including a value that is itself a string, and ending
 * the caller's work with the refusal as the message.
 * @module tests/unit/refusal.test
 */

import { isRefusal, valueOrThrow } from 'src/utils/refusal';

describe('telling a refusal from a value', () => {
	it.each([
		{ read: { refusal: 'no' }, refused: true },
		{ read: { value: null }, refused: false },
		// The case a bare string refusal could not tell apart from a value.
		{ read: { value: '' }, refused: false },
		{ read: { value: 'no' }, refused: false },
	])('reads $read as refused: $refused', ({ read, refused }) => {
		expect(isRefusal(read)).toBe(refused);
	});
});

describe('the value of a step that must not refuse', () => {
	it('is the value the step produced', () => {
		expect(valueOrThrow({ value: '' })).toBe('');
	});

	it('throws the refusal as the message the user reads', () => {
		expect(() =>
			valueOrThrow({
				refusal: 'Recording the system output is not granted here.',
			}),
		).toThrow(
			new Error('Recording the system output is not granted here.'),
		);
	});
});
