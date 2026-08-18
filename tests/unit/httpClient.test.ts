/**
 * Tests for friendlyHttpHint (human-readable guidance for common provider
 * HTTP failures) and uploadTimeoutMs (the payload-scaled request deadline
 * that keeps a large but healthy upload from being aborted prematurely).
 */

import {
	friendlyHttpHint,
	HttpError,
	providerMessage,
	requestRaw,
	uploadTimeoutMs,
} from 'src/transcription/httpClient';
import {
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_REQUEST_TIMEOUT_MS,
} from 'src/constants';
import { withRequestUrl } from '../helpers/network';

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
	])('returns no hint for $name', ({ status, body }) => {
		expect(friendlyHttpHint(status, body)).toBe('');
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
		mockFetch(
			(_url, init) =>
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
