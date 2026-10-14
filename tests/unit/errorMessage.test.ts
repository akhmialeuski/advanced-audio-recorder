/**
 * Tests the one reading of a caught value every notice and log line goes
 * through. A `catch` binds `unknown`, so what reaches it is not always an
 * Error, and a notice that said "undefined" or "[object Object]" would leave
 * the user with nothing to act on.
 * @module tests/unit/errorMessage.test
 */

import { errorMessage } from 'src/errors';

describe('errorMessage', () => {
	it.each([
		{
			name: 'an Error',
			caught: new Error('disk full'),
			expected: 'disk full',
		},
		{
			name: 'an Error subclass',
			caught: new TypeError('not a function'),
			expected: 'not a function',
		},
		{
			name: 'a thrown string',
			caught: 'quota exceeded',
			expected: 'quota exceeded',
		},
		{ name: 'a thrown number', caught: 404, expected: '404' },
		{ name: 'undefined', caught: undefined, expected: 'undefined' },
	])('reads $name as "$expected"', ({ caught, expected }) => {
		expect(errorMessage(caught)).toBe(expected);
	});
});
