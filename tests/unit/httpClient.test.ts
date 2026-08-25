/**
 * Tests for friendlyHttpHint (human-readable guidance for common provider
 * HTTP failures) and uploadTimeoutMs (the payload-scaled request deadline
 * that keeps a large but healthy upload from being aborted prematurely).
 */

import {
	friendlyHttpHint,
	HttpError,
	providerMessage,
	requestJson,
	requestRaw,
	uploadTimeoutMs,
} from 'src/transcription/httpClient';
import {
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_REQUEST_TIMEOUT_MS,
} from 'src/constants';
import { withRequestUrl } from '../helpers/network';
import { defined } from '../helpers/assertions';

describe('friendlyHttpHint', () => {
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
	])('reads $name as "$says"', ({ status, body, says }) => {
		expect(friendlyHttpHint(status, body).toLowerCase()).toContain(says);
	});

	it('treats a 403 "insufficient permissions" as auth, not billing', () => {
		// Regression: the bare "insufficient" marker used to misclassify a
		// forbidden/scope error as a billing problem. It must read as auth.
		const hint = friendlyHttpHint(
			403,
			'{"error":"insufficient permissions for this resource"}',
		).toLowerCase();
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
	])('names the region for $name', ({ status, body }) => {
		const hint = friendlyHttpHint(status, body).toLowerCase();

		expect(hint).toContain('does not serve your region');
		expect(hint).not.toContain('authentication failed');
	});

	it('names both ways out of a region refusal', () => {
		// Another engine, or an endpoint that does serve the caller. The
		// second is what a user in a blocked country already relies on, and it
		// is a field on the same page.
		const hint = friendlyHttpHint(
			400,
			'{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
		).toLowerCase();

		expect(hint).toContain('engines');
		expect(hint).toContain('base url');
	});

	it.each([
		{
			name: 'an unrecognized client error',
			status: 404,
			body: 'Not Found',
		},
		{ name: 'a success status', status: 200, body: 'OK' },
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
	])('returns no hint for $name', ({ status, body }) => {
		expect(friendlyHttpHint(status, body)).toBe('');
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
	])('treats $status as a server fault: $hinted', ({ status, hinted }) => {
		const hint = friendlyHttpHint(status, '').toLowerCase();

		expect(hint.includes('server error')).toBe(hinted);
	});
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

describe('requestRaw abort support', () => {
	afterEach(() => {
		delete (globalThis as { fetch?: unknown }).fetch;
	});

	function mockFetch(impl: (typeof globalThis)['fetch']): jest.Mock {
		const mock = jest.fn(impl);
		(globalThis as { fetch?: unknown }).fetch = mock;
		return mock;
	}

	/** A minimal Response stand-in (jsdom ships no Response constructor). */
	function fakeResponse(
		status: number,
		body: string,
		headers: Record<string, string> = {},
	): Response {
		return {
			status,
			text: () => Promise.resolve(body),
			headers: new Map(Object.entries(headers)),
		} as unknown as Response;
	}

	it('sends the request through fetch when a signal is provided', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(
				fakeResponse(200, '{"ok":true}', { 'x-test': 'yes' }),
			),
		);

		const response = await requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			body: 'payload',
			signal: new AbortController().signal,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect(response.text).toBe('{"ok":true}');
		expect(response.headers['x-test']).toBe('yes');
	});

	it('rejects with a cancellation HttpError when the signal aborts mid-flight', async () => {
		const controller = new AbortController();
		(globalThis as { fetch?: unknown }).fetch = fetchThatOnlyAborts();

		const pending = requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			signal: controller.signal,
		});
		controller.abort();

		await expect(pending).rejects.toThrow(HttpError);
		await expect(pending).rejects.toThrow(/was cancelled/);
	});

	it('falls back to requestUrl when fetch fails at the network layer (CORS)', async () => {
		mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: '{"via":"requestUrl"}',
		}));

		const response = await requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			signal: new AbortController().signal,
		});

		expect(response.text).toBe('{"via":"requestUrl"}');
	});

	it('does not touch fetch when no signal is provided', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(fakeResponse(200, '')),
		);
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: 'ok',
		}));

		await requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'GET',
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

/** A fetch that never settles until its signal aborts, then rejects. */
function fetchThatOnlyAborts(): jest.Mock {
	return jest.fn(
		(_url: unknown, init?: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(
						new DOMException(
							'The operation was aborted.',
							'AbortError',
						),
					);
				});
			}),
	);
}

describe('requests that never come back', () => {
	afterEach(() => {
		jest.useRealTimers();
		delete (globalThis as { fetch?: unknown }).fetch;
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

	it('reports a hanging fetch as a timeout rather than a cancellation', async () => {
		jest.useFakeTimers();
		(globalThis as { fetch?: unknown }).fetch = fetchThatOnlyAborts();

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

	// A run cancelled before the request went out must not reach the network
	// at all; the abort is applied to the new controller straight away.
	it('never waits on a request whose signal was already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		(globalThis as { fetch?: unknown }).fetch = jest.fn(
			(_url: unknown, init?: { signal?: AbortSignal }) =>
				init?.signal?.aborted
					? Promise.reject(new DOMException('Aborted', 'AbortError'))
					: Promise.resolve({
							status: 200,
							text: () => Promise.resolve('{}'),
							headers: new Map(),
						} as unknown as Response),
		);

		await expect(
			requestRaw({
				url: 'https://api.example.com/v1/transcribe',
				method: 'POST',
				signal: controller.signal,
			}),
		).rejects.toThrow(/was cancelled/);
	});
});

describe('a transport that fails for a reason of its own', () => {
	afterEach(() => {
		delete (globalThis as { fetch?: unknown }).fetch;
	});

	it('wraps a transport failure as an HttpError naming the endpoint', async () => {
		withRequestUrl(() => {
			throw new Error('net::ERR_NAME_NOT_RESOLVED');
		});

		const failing = requestRaw({
			url: 'https://api.example.com/v1/transcribe?key=secret',
			method: 'POST',
		});

		await expect(failing).rejects.toThrow(HttpError);
		await expect(failing).rejects.toThrow(
			'Request to https://api.example.com/v1/transcribe failed: net::ERR_NAME_NOT_RESOLVED',
		);
	});

	it('names a transport that rejected with something other than an Error', async () => {
		withRequestUrl(() => Promise.reject('the socket closed'));

		await expect(
			requestRaw({
				url: 'https://api.example.com/v1/transcribe',
				method: 'POST',
			}),
		).rejects.toThrow(/failed: the socket closed/);
	});

	it('sends the content type the caller named through fetch', async () => {
		const fetchMock = jest.fn(() =>
			Promise.resolve({
				status: 200,
				text: () => Promise.resolve('{}'),
				headers: new Map(),
			} as unknown as Response),
		);
		(globalThis as { fetch?: unknown }).fetch = fetchMock;

		await requestRaw({
			url: 'https://api.example.com/v1/transcribe',
			method: 'POST',
			contentType: 'audio/wav',
			signal: new AbortController().signal,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.example.com/v1/transcribe',
			expect.objectContaining({
				headers: expect.objectContaining({
					'Content-Type': 'audio/wav',
				}),
			}),
		);
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
	/** Answers one request with the given status, body, and headers. */
	function answerWith(
		status: number,
		text = '',
		headers: Record<string, string> = {},
	): void {
		withRequestUrl(() => ({ status, headers, text }));
	}

	/**
	 * Sends one request and returns the failure it raised.
	 * @returns The HttpError the request failed with
	 */
	async function failure(): Promise<HttpError> {
		try {
			await requestRaw({
				url: 'https://api.example/v1/x',
				method: 'GET',
			});
		} catch (error) {
			if (error instanceof HttpError) {
				return error;
			}
			throw error;
		}
		throw new Error('the request did not fail');
	}

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
			answerWith(status, body);

			expect((await failure()).retryable).toBe(retryable);
		},
	);

	// A quota that ran out is a rate limit shaped like one and fixed by
	// nothing a retry can do, so the billing branch wins over the 429.
	it('keeps the billing wording on an exhausted quota', async () => {
		answerWith(429, '{"error":{"message":"insufficient_quota"}}');

		expect((await failure()).message).toContain('Out of API quota');
	});

	it('reads the pause a provider asked for in seconds', async () => {
		answerWith(429, '', { 'Retry-After': '12' });

		expect((await failure()).retryAfterMs).toBe(12000);
	});

	it('reads the pause a provider gave as a date', async () => {
		const when = new Date(Date.now() + 30_000).toUTCString();
		answerWith(429, '', { 'Retry-After': when });

		// Wall-clock arithmetic, so the exact value drifts by the odd
		// millisecond; what matters is that it landed near the half minute.
		expect(defined((await failure()).retryAfterMs)).toBeGreaterThan(25_000);
		expect(defined((await failure()).retryAfterMs)).toBeLessThan(35_000);
	});

	// Header names arrive in whatever case the server sent them.
	it('reads the pause whatever case the header came in', async () => {
		answerWith(429, '', { 'retry-after': '5' });

		expect((await failure()).retryAfterMs).toBe(5000);
	});

	it.each([
		{ name: 'no header at all', headers: {} },
		{ name: 'a value that is neither', headers: { 'Retry-After': 'soon' } },
		{
			name: 'a date in the past',
			headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:00 GMT' },
		},
	])('advises no particular pause for $name', async ({ headers }) => {
		answerWith(429, '', headers);

		expect((await failure()).retryAfterMs).toBeUndefined();
	});
});
