/**
 * Narrowing helpers for test assertions.
 *
 * `noUncheckedIndexedAccess` types every indexed read as possibly undefined,
 * which is right: a test that reads `parts[0]` after asserting the list is
 * non-empty is relying on that assertion, and if the list is ever empty the
 * bare index yields a `TypeError: Cannot read properties of undefined` several
 * lines later with no indication of what was actually missing.
 *
 * These helpers make the reliance explicit and fail where it breaks, with a
 * message naming the index and the actual length.
 * @module tests/helpers/assertions
 */

/**
 * The element at an index, asserting it exists.
 * @param list - The list to read from
 * @param index - Index to read
 * @param what - Optional description used in the failure message
 * @returns The element at the index
 */
export function at<T>(
	list: ArrayLike<T> | undefined | null,
	index: number,
	what = 'item',
): T {
	if (!list) {
		throw new Error(`Expected a list of ${what}s, got ${String(list)}`);
	}
	const value = list[index];
	if (value === undefined) {
		throw new Error(
			`Expected ${what} at index ${String(index)}, but the list has ` +
				`${String(list.length)} entr${list.length === 1 ? 'y' : 'ies'}`,
		);
	}
	return value;
}

/**
 * A value, asserting it is neither undefined nor null.
 * @param value - The value to narrow
 * @param what - Optional description used in the failure message
 * @returns The value, narrowed
 */
export function defined<T>(value: T | undefined | null, what = 'value'): T {
	if (value === undefined || value === null) {
		throw new Error(`Expected ${what} to be defined, got ${String(value)}`);
	}
	return value;
}

/**
 * The JSON body of a captured request, asserting it was sent as text.
 *
 * A request body is `string | ArrayBuffer`, and `String(body)` on the binary
 * form yields "[object ArrayBuffer]", which then fails to parse with a message
 * that says nothing about the real problem. This narrows first and reports the
 * actual type when a test captured a request it did not expect.
 * @param request - The captured request, when one was captured
 * @returns The parsed JSON body
 */
export function jsonBody<T>(
	request: { body?: string | ArrayBuffer } | undefined,
): T {
	const body = defined(request, 'captured request').body;
	if (typeof body !== 'string') {
		throw new Error(
			`Expected a text request body to parse as JSON, got ${
				body === undefined ? 'no body' : 'binary data'
			}`,
		);
	}
	return JSON.parse(body) as T;
}
