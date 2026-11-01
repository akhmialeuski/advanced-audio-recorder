/**
 * Tests for what a failed request carries out of the HTTP client - the
 * human-readable guidance and whether the run may send it again, both read off
 * the HttpError the client throws - and for the two request deadlines:
 * uploadTimeoutMs, the payload-scaled budget that keeps a large but healthy
 * upload from being aborted prematurely, and inferenceTimeoutMs, which raises it
 * to an engine's own floor because the byte count of a compressed container says
 * nothing about how long the endpoint needs to transcribe it.
 */

import {
	HttpError,
	inferenceTimeoutMs,
	providerMessage,
	requestJson,
	requestRaw,
	uploadTimeoutMs,
} from 'src/transcription/httpClient';
import {
	GEMINI_GENERATE_MIN_TIMEOUT_MS,
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_REQUEST_TIMEOUT_MS,
	VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS,
} from 'src/constants';
import { captureRequests, withRequestUrl } from '../helpers/network';
import { defined } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';

/**
 * Sends one request against a scripted answer and returns the failure it
 * raised.
 *
 * Asserted off the error rather than off a classifier exported for the
 * purpose: the guidance and the retry decision are two readings of one
 * response, and this is the object both of them travel on.
 * @param status - Status the endpoint answers with
 * @param body - Body the endpoint answers with
 * @param headers - Headers the endpoint answers with
 * @returns The HttpError the request failed with
 */
async function failureFor(
	status: number,
	body = '',
	headers: Record<string, string> = {},
): Promise<HttpError> {
	withRequestUrl(() => ({ status, headers, text: body }));
	try {
		await requestRaw({ url: 'https://api.example/v1/x', method: 'GET' });
	} catch (error) {
		if (error instanceof HttpError) {
			return error;
		}
		throw error;
	}
	throw new Error('the request did not fail');
}

/**
 * The sentence a failed request hands the user, lowercased for matching.
 * @param status - Status the endpoint answers with
 * @param body - Body the endpoint answers with
 * @returns The message, lowercased
 */
async function hintFor(status: number, body = ''): Promise<string> {
	return (await failureFor(status, body)).message.toLowerCase();
}

describe('the guidance a failed request carries', () => {
	it.each([
		{
			name: 'an OpenAI insufficient_quota 429',
			status: 429,
			body: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
			says: 'quota or credit',
		},
		{
			name: 'an Anthropic low credit balance on a 400',
			status: 400,
			body: '{"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API"}}',
			says: 'quota or credit',
		},
		{
			name: 'a 402 Payment Required with an empty body',
			status: 402,
			body: '',
			says: 'quota or credit',
		},
		{
			name: 'a Deepgram INSUFFICIENT_CREDITS body',
			status: 400,
			body: '{"err_code":"INSUFFICIENT_CREDITS"}',
			says: 'quota or credit',
		},
		{
			name: 'a 401 with a bad key',
			status: 401,
			body: 'Incorrect API key provided',
			says: 'authentication failed',
		},
		{
			name: 'a plain 429 with no billing markers',
			status: 429,
			body: 'Too Many Requests, slow down',
			says: 'rate limit',
		},
		{
			name: 'a 503 from the provider',
			status: 503,
			body: 'Service Unavailable',
			says: 'server error',
		},
		{
			name: 'a 500 from the provider',
			status: 500,
			body: 'Internal Server Error',
			says: 'server error',
		},
	])('reads $name as "$says"', async ({ status, body, says }) => {
		expect(await hintFor(status, body)).toContain(says);
	});

	it('treats a 403 "insufficient permissions" as auth, not billing', async () => {
		// Regression: the bare "insufficient" marker used to misclassify a
		// forbidden/scope error as a billing problem. It must read as auth.
		const hint = await hintFor(
			403,
			'{"error":"insufficient permissions for this resource"}',
		);
		expect(hint).toContain('authentication failed');
		expect(hint).not.toContain('quota or credit');
	});

	it.each([
		{
			// The status says the request was malformed and it was not: the
			// service does not serve the caller's country, which no key and no
			// retry fix. Left unrecognized, the whole envelope was shown and
			// the one sentence that mattered was buried in it.
			name: 'a Gemini FAILED_PRECONDITION 400',
			status: 400,
			body: '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
		},
		{
			// The same refusal under a status the auth branch would otherwise
			// claim, so the region check has to be asked first.
			name: 'an OpenAI unsupported-country 403',
			status: 403,
			body: '{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}',
		},
	])('names the region for $name', async ({ status, body }) => {
		const hint = await hintFor(status, body);

		expect(hint).toContain('does not serve your region');
		expect(hint).not.toContain('authentication failed');
	});

	it('names both ways out of a region refusal', async () => {
		// Another engine, or an endpoint that does serve the caller. The
		// second is what a user in a blocked country already relies on, and it
		// is a field on the same page.
		const hint = await hintFor(
			400,
			'{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
		);

		expect(hint).toContain('engines');
		expect(hint).toContain('base url');
	});

	it.each([
		{
			name: 'an unrecognized client error',
			status: 404,
			body: 'Not Found',
		},
		{ name: 'a redirect', status: 302, body: 'Found' },
		// The bodies a failing endpoint returns when it is not the API at
		// all. Each must read as "no hint" rather than break the error path
		// that shows it, or throw out of a parse.
		{ name: 'an empty body', status: 404, body: '' },
		{
			name: 'an HTML error page from a proxy',
			status: 404,
			body: '<html><body>Not Found</body></html>',
		},
		{ name: 'a body that is a bare JSON null', status: 404, body: 'null' },
		{ name: 'a body that is a JSON list', status: 404, body: '[]' },
		{
			name: 'JSON with an unfamiliar error shape',
			status: 400,
			body: '{"problem":{"kind":"unknown"}}',
		},
		{ name: 'truncated JSON', status: 400, body: '{"error":{' },
	])('carries no guidance for $name', async ({ status, body }) => {
		// No hint means nothing is prefixed to the diagnostic detail, which
		// is what the message then opens with.
		expect((await failureFor(status, body)).message).toMatch(
			/^Request to /,
		);
	});

	it.each([
		// Both ends of the 5xx range and the status just below it: the advice
		// is "wait and retry", which is right for a server fault and wrong
		// for a client one, so 499/500 is where it must not slip.
		{ status: 500, hinted: true },
		{ status: 502, hinted: true },
		{ status: 503, hinted: true },
		{ status: 599, hinted: true },
		{ status: 499, hinted: false },
		{ status: 404, hinted: false },
	])(
		'treats $status as a server fault: $hinted',
		async ({ status, hinted }) => {
			const hint = await hintFor(status);

			expect(hint.includes('server error')).toBe(hinted);
		},
	);
});

describe('providerMessage', () => {
	it('lifts the sentence out of a Google error envelope', () => {
		expect(
			providerMessage(
				'{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
			),
		).toBe('User location is not supported for the API use.');
	});

	it('lifts it out of a Deepgram envelope, which names the field differently', () => {
		expect(
			providerMessage(
				'{"err_code":"Bad Request","err_msg":"Bad Request: failed to process audio: corrupt or unsupported data","request_id":"019fc75b"}',
			),
		).toBe(
			'Bad Request: failed to process audio: corrupt or unsupported data',
		);
	});

	it.each([
		{ name: 'a JSON string', body: '"just a sentence"' },
		{ name: 'a JSON array', body: '[{"error":"nope"}]' },
		{ name: 'a JSON number', body: '42' },
	])('keeps $name, which carries no envelope to look in', ({ body }) => {
		expect(providerMessage(body)).toBe(body);
	});

	it('keeps the body when there is no sentence to lift', () => {
		// An HTML error page from a proxy, a truncated excerpt, or JSON with no
		// message field: there is nothing better to show than what arrived.
		expect(
			providerMessage('<html><body>502 Bad Gateway</body></html>'),
		).toBe('<html><body>502 Bad Gateway</body></html>');
		expect(providerMessage('{"error":{"code":400}}')).toBe(
			'{"error":{"code":400}}',
		);
		expect(providerMessage('{"error":{"message":"   "}}')).toBe(
			'{"error":{"message":"   "}}',
		);
	});
});

describe('uploadTimeoutMs', () => {
	it('uses the floor timeout for an empty payload', () => {
		expect(uploadTimeoutMs(0)).toBe(TRANSCRIBE_REQUEST_TIMEOUT_MS);
	});

	it('scales above the floor for a sizeable payload', () => {
		const timeout = uploadTimeoutMs(100 * 1024 * 1024);
		expect(timeout).toBeGreaterThan(TRANSCRIBE_REQUEST_TIMEOUT_MS);
		expect(timeout).toBeLessThanOrEqual(TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS);
	});

	it('caps a very large payload at the ceiling', () => {
		expect(uploadTimeoutMs(8 * 1024 * 1024 * 1024)).toBe(
			TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
		);
	});

	it('honors a caller-supplied cap below the default ceiling', () => {
		// The user-configured per-request limit lowers the cap; a large payload
		// that would otherwise scale higher is clamped to it.
		const cap = 5 * 60_000;
		expect(uploadTimeoutMs(8 * 1024 * 1024 * 1024, cap)).toBe(cap);
	});

	it('is monotonic in payload size', () => {
		expect(uploadTimeoutMs(10 * 1024 * 1024)).toBeLessThanOrEqual(
			uploadTimeoutMs(20 * 1024 * 1024),
		);
	});
});

describe('inferenceTimeoutMs', () => {
	/** A floor standing in for whichever engine declares one. */
	const FLOOR_MS = 10 * 60_000;

	it('gives a small upload the floor rather than the upload proxy', () => {
		// A few bytes must not inherit the short transfer budget: the endpoint
		// still has a whole recording to work through, and the byte count of a
		// compressed container says nothing about how long that takes.
		expect(inferenceTimeoutMs(8, FLOOR_MS)).toBe(FLOOR_MS);
	});

	it('uses the size-scaled budget once it exceeds the floor', () => {
		const bigBytes = 600 * 1024 * 1024;
		const scaled = uploadTimeoutMs(bigBytes);

		expect(scaled).toBeGreaterThan(FLOOR_MS);
		expect(inferenceTimeoutMs(bigBytes, FLOOR_MS)).toBe(scaled);
	});

	it('clamps to the configured cap even below the floor', () => {
		// A user who allows five minutes overrides a ten-minute floor: the
		// per-request cap wins, so a run never waits longer than configured.
		const cap = 5 * 60_000;

		expect(inferenceTimeoutMs(8, FLOOR_MS, cap)).toBe(cap);
		expect(inferenceTimeoutMs(600 * 1024 * 1024, FLOOR_MS, cap)).toBe(cap);
	});

	it.each([
		{
			name: 'Gemini, whose parts are at most fifteen minutes of audio',
			floorMs: GEMINI_GENERATE_MIN_TIMEOUT_MS,
		},
		{
			name: 'Voxtral, which sends up to three hours in one request',
			floorMs: VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS,
		},
	])(
		'keeps a long compressed upload off the two-minute floor for $name',
		({ floorMs }) => {
			// The case the floors exist for. A three-hour recording in a
			// compressed container the endpoint reads untouched is about 86 MB
			// at 64 kbps, which the transfer budget alone answers with three and
			// a half minutes - a healthy request aborted mid-transcription.
			const threeHoursCompressed = 86 * 1024 * 1024;

			expect(uploadTimeoutMs(threeHoursCompressed)).toBeLessThan(floorMs);
			expect(inferenceTimeoutMs(threeHoursCompressed, floorMs)).toBe(
				floorMs,
			);
		},
	);
});

describe("the run's cancel", () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	/** A requestUrl that never answers, as a long upload looks from inside. */
	function endpointStillWorking(): void {
		withRequestUrl(() => new Promise(() => undefined));
	}

	// requestUrl cannot be aborted, so what the cancel can do is stop the run
	// waiting for it. Waiting out the request's own deadline instead held the
	// dialog for up to an hour after the user pressed Cancel.
	it('releases the caller the moment the run is cancelled', async () => {
		endpointStillWorking();
		const controller = new AbortController();

		const pending = requestRaw({
			url: 'https://api.example.com/v1/transcribe?key=secret',
			method: 'POST',
			body: 'the audio',
			signal: controller.signal,
		});
		controller.abort();

		await expect(pending).rejects.toThrow(
			new HttpError(
				0,
				'Request to https://api.example.com/v1/transcribe was cancelled.',
			),
		);
	});

	// A run cancelled before the request went out sends nothing, because the
	// request could not be taken back once it had.
	it('sends nothing when the signal was already aborted', async () => {
		const sent = captureRequests({ status: 200, text: '{}' });
		const controller = new AbortController();
		controller.abort();

		await expect(
			requestRaw({
				url: 'https://api.example.com/v1/transcribe',
				method: 'POST',
				body: 'the audio',
				signal: controller.signal,
			}),
		).rejects.toThrow(/was cancelled/);

		expect(sent).toHaveLength(0);
	});

	it('reports a hanging request as a timeout rather than a cancellation', async () => {
		jest.useFakeTimers();
		endpointStillWorking();

		const settled = requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			timeoutMs: 5_000,
			signal: new AbortController().signal,
		}).catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(5_000);

		expect(await settled).toHaveProperty(
			'message',
			expect.stringMatching(/timed out after 5000 ms/),
		);
	});

	// One run hands the same signal to every request it makes, a dozen parts
	// and their LLM steps, so a listener left behind by each answered request
	// would keep all of them reachable until the run ends.
	it('stops listening to the cancel once the request has answered', async () => {
		captureRequests({ status: 200, text: '{}' });
		const controller = new AbortController();
		const removed = jest.spyOn(controller.signal, 'removeEventListener');

		await requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			signal: controller.signal,
		});

		expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	// A request that creates something on the server names it only in its
	// answer, and an answer that arrives after the run stopped waiting is the
	// one chance left to clean it up. An answer the caller still read, or a
	// failure that created nothing, is not handed over.
	it.each([
		{ release: 'cancel', status: 200, listening: true, handedOver: 1 },
		{ release: 'deadline', status: 200, listening: true, handedOver: 1 },
		{ release: 'cancel', status: 500, listening: true, handedOver: 0 },
		{ release: 'nothing', status: 200, listening: true, handedOver: 0 },
		{ release: 'cancel', status: 200, listening: false, handedOver: 0 },
	])(
		'hands a $status answer after $release to onAbandoned $handedOver times (listening: $listening)',
		async ({ release, status, listening, handedOver }) => {
			jest.useFakeTimers();
			let answer = (): void => undefined;
			withRequestUrl(
				() =>
					new Promise((resolve) => {
						answer = () => {
							resolve({ status, headers: {}, text: 'late' });
						};
					}),
			);
			const controller = new AbortController();
			const abandoned: string[] = [];

			const settled = requestRaw({
				url: 'https://api.example.com/v1/files',
				method: 'POST',
				timeoutMs: 5_000,
				signal: controller.signal,
				...(listening
					? { onAbandoned: (late) => abandoned.push(late.text) }
					: {}),
			}).catch(() => undefined);
			if (release === 'cancel') {
				controller.abort();
			}
			if (release === 'deadline') {
				await jest.advanceTimersByTimeAsync(5_000);
			}
			answer();
			await settled;
			await flushMicrotasks();

			expect(abandoned).toHaveLength(handedOver);
		},
	);
});

describe('a request body goes out once', () => {
	afterEach(() => {
		delete (globalThis as { fetch?: unknown }).fetch;
	});

	// An endpoint that allows the preflight, takes the body, and answers
	// without CORS headers. The browser reports that as the same TypeError as a
	// refused preflight, so nothing the client sees says whether the body
	// arrived, and a resend on another transport was the same transcription or
	// LLM call billed a second time.
	it('never resends a body the endpoint may already have taken', async () => {
		const bodiesSeenByFetch: unknown[] = [];
		(globalThis as { fetch?: unknown }).fetch = jest.fn(
			(_url: unknown, init?: RequestInit) => {
				bodiesSeenByFetch.push(init?.body);
				return Promise.reject(new TypeError('Failed to fetch'));
			},
		);
		const sentByRequestUrl = captureRequests({ status: 200, text: '{}' });

		await requestRaw({
			url: 'https://answers-without-cors.example.com/v1/listen',
			method: 'POST',
			body: 'the audio',
			signal: new AbortController().signal,
		}).catch(() => undefined);

		const bodies = [
			...bodiesSeenByFetch,
			...sentByRequestUrl.map((request) => request.body),
		].filter((body) => body === 'the audio');
		expect(bodies).toHaveLength(1);
	});
});

describe('requests that never come back', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	// requestUrl cannot be aborted, so the request itself keeps running; the
	// timeout is what lets the dialog stop waiting on it.
	it('gives up on a requestUrl transport that hangs past the deadline', async () => {
		jest.useFakeTimers();
		withRequestUrl(() => new Promise(() => undefined));

		// The rejection lands while the clock is being advanced, so the
		// handler is attached before the tick rather than after it.
		const settled = requestRaw({
			url: 'https://api.example.com/v1/transcribe?key=secret',
			method: 'POST',
			timeoutMs: 5_000,
		}).catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(5_000);

		const error = await settled;
		expect(error).toBeInstanceOf(HttpError);
		// The message names the endpoint without the key that was in its query.
		expect(error).toHaveProperty(
			'message',
			'Request to https://api.example.com/v1/transcribe timed out after 5000 ms.',
		);
	});
});

describe('a transport that fails for a reason of its own', () => {
	// The transport can refuse before it has a promise to hand back, or reject
	// the promise later, and the run reads both the same way.
	it.each([
		{
			when: 'before the request starts',
			fail: (): never => {
				throw new Error('net::ERR_NAME_NOT_RESOLVED');
			},
		},
		{
			when: 'while the request is in flight',
			fail: (): Promise<never> =>
				Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
		},
	])(
		'wraps a transport failure $when as an HttpError naming the endpoint',
		async ({ fail }) => {
			withRequestUrl(fail);

			const failing = requestRaw({
				url: 'https://api.example.com/v1/transcribe?key=secret',
				method: 'POST',
			});

			await expect(failing).rejects.toThrow(HttpError);
			await expect(failing).rejects.toThrow(
				'Request to https://api.example.com/v1/transcribe failed: net::ERR_NAME_NOT_RESOLVED',
			);
		},
	);

	it('names a transport that rejected with something other than an Error', async () => {
		withRequestUrl(() => Promise.reject('the socket closed'));

		await expect(
			requestRaw({
				url: 'https://api.example.com/v1/transcribe',
				method: 'POST',
			}),
		).rejects.toThrow(/failed: the socket closed/);
	});
});

describe('requestJson', () => {
	// A 2xx that is not JSON (an HTML error page from a proxy, a truncated
	// body) would otherwise surface as a raw SyntaxError with no endpoint.
	it.each([
		{ name: 'an HTML error page', text: '<html>Gateway</html>' },
		{ name: 'an empty body', text: '' },
		{ name: 'a truncated object', text: '{"segments":' },
	])('reports $name as a non-JSON response', async ({ text }) => {
		withRequestUrl(() => ({ status: 200, headers: {}, text }));

		await expect(
			requestJson({
				url: 'https://api.example.com/v1/transcribe?key=secret',
				method: 'POST',
			}),
		).rejects.toThrow(
			'Request to https://api.example.com/v1/transcribe returned a non-JSON response.',
		);
	});

	it('parses a JSON body into the value the caller asked for', async () => {
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: '{"text":"hi"}',
		}));

		await expect(
			requestJson<{ text: string }>({
				url: 'https://api.example.com/v1/transcribe',
				method: 'POST',
			}),
		).resolves.toEqual({ text: 'hi' });
	});
});

// The plugin recognised a rate limit well enough to tell the user to wait and
// try again, and then never did either: the part failed, its ten minutes
// vanished from the transcript, and only a full re-run (paid again) could get
// them back. Whether re-sending could help is decided where the status, the
// body, and the headers are all still in hand.
describe('a failure the run could try again', () => {
	it.each([
		{ name: 'a rate limit', status: 429, body: '', retryable: true },
		{
			name: 'a rate limit the body names on another status',
			status: 400,
			body: 'rate limit exceeded',
			retryable: true,
		},
		{ name: 'a provider outage', status: 503, body: '', retryable: true },
		{ name: 'an internal error', status: 500, body: '', retryable: true },
		{ name: 'a bad key', status: 401, body: '', retryable: false },
		{ name: 'a forbidden key', status: 403, body: '', retryable: false },
		{
			name: 'an exhausted quota',
			status: 429,
			body: '{"error":{"message":"insufficient_quota"}}',
			retryable: false,
		},
		{
			name: 'a region refusal',
			status: 400,
			body: 'User location is not supported for the API use',
			retryable: false,
		},
		{
			name: 'a malformed request',
			status: 400,
			body: '',
			retryable: false,
		},
		{ name: 'a missing model', status: 404, body: '', retryable: false },
	])(
		'reports $name as retryable: $retryable',
		async ({ status, body, retryable }) => {
			expect((await failureFor(status, body)).retryable).toBe(retryable);
		},
	);

	// A quota that ran out is a rate limit shaped like one and fixed by
	// nothing a retry can do, so the billing branch wins over the 429.
	it('keeps the billing wording on an exhausted quota', async () => {
		const failure = await failureFor(
			429,
			'{"error":{"message":"insufficient_quota"}}',
		);

		expect(failure.message).toContain('Out of API quota');
	});

	it('reads the pause a provider asked for in seconds', async () => {
		const failure = await failureFor(429, '', { 'Retry-After': '12' });

		expect(failure.retryAfterMs).toBe(12000);
	});

	it('reads the pause a provider gave as a date', async () => {
		const when = new Date(Date.now() + 30_000).toUTCString();

		const failure = await failureFor(429, '', { 'Retry-After': when });

		// Wall-clock arithmetic, so the exact value drifts by the odd
		// millisecond; what matters is that it landed near the half minute.
		expect(defined(failure.retryAfterMs)).toBeGreaterThan(25_000);
		expect(defined(failure.retryAfterMs)).toBeLessThan(35_000);
	});

	// Header names arrive in whatever case the server sent them.
	it('reads the pause whatever case the header came in', async () => {
		const failure = await failureFor(429, '', { 'retry-after': '5' });

		expect(failure.retryAfterMs).toBe(5000);
	});

	it.each([
		{ name: 'no header at all', headers: {} },
		{ name: 'a value that is neither', headers: { 'Retry-After': 'soon' } },
		{
			name: 'a date in the past',
			headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:00 GMT' },
		},
	])('advises no particular pause for $name', async ({ headers }) => {
		const failure = await failureFor(429, '', headers);

		expect(failure.retryAfterMs).toBeUndefined();
	});
});
