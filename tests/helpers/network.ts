/**
 * Scripting the network for a test, and recording what was sent.
 *
 * The obsidian mock routes every `requestUrl` through one module-level
 * handler. Installing it directly works, but it is shared state a test has to
 * remember to take back down, and the reset is a convention rather than a
 * guarantee - a failing assertion before an `afterEach` used to leave the next
 * suite's requests answered by the previous suite's handler.
 *
 * These wrap the install so the intent reads in the call, and pair with the
 * reset in tests/setupAfterEnv.ts, which clears the handler before every test
 * whatever the last one did.
 * @module tests/helpers/network
 */

import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
	type RequestUrlHandler,
} from '../mocks/obsidian';

/**
 * Answers every request of this test with the given handler.
 * @param handler - What to answer with, per request
 */
export function withRequestUrl(handler: RequestUrlHandler): void {
	__setRequestUrlHandler(handler);
}

/**
 * Answers every request with one fixed response, and records what was sent.
 *
 * The common shape: a test cares what the client put on the wire, not about
 * varying the answer. The returned array is the requests in order.
 * @param response - The response every request gets
 * @returns The captured requests, filled as they are made
 */
export function captureRequests(
	response: Partial<MockRequestUrlResponse> = {},
): MockRequestUrlParam[] {
	const sent: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param) => {
		sent.push(param);
		return { status: 200, headers: {}, text: '', ...response };
	});
	return sent;
}

/**
 * Answers each request from a queue, in order, and records what was sent.
 *
 * For a run that makes several calls and reads a different answer from each -
 * a chunked upload, a two-pass transcription. A request past the end of the
 * queue reuses the last answer rather than failing, so a test that adds a call
 * does not have to grow the queue to stay green.
 * @param responses - The answers, in the order the calls are expected
 * @returns The captured requests, filled as they are made
 */
export function queueResponses(
	responses: Partial<MockRequestUrlResponse>[],
): MockRequestUrlParam[] {
	const sent: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param) => {
		const next =
			responses[Math.min(sent.length, responses.length - 1)] ?? {};
		sent.push(param);
		return { status: 200, headers: {}, text: '', ...next };
	});
	return sent;
}
