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
import { __setRequestUrlHandler } from '../mocks/obsidian';

describe('friendlyHttpHint', () => {
	it('flags an OpenAI insufficient_quota 429 as a billing problem', () => {
		const hint = friendlyHttpHint(
			429,
			'{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
		);
		expect(hint.toLowerCase()).toContain('quota or credit');
	});

	it('flags an Anthropic low credit balance (HTTP 400) as a billing problem', () => {
		const hint = friendlyHttpHint(
			400,
			'{"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API"}}',
		);
		expect(hint.toLowerCase()).toContain('quota or credit');
	});

	it('flags HTTP 402 Payment Required as billing even with an empty body', () => {
		expect(friendlyHttpHint(402, '').toLowerCase()).toContain(
			'quota or credit',
		);
	});

	it('reports an authentication problem for 401', () => {
		expect(
			friendlyHttpHint(401, 'Incorrect API key provided').toLowerCase(),
		).toContain('authentication failed');
	});

	it('flags a Deepgram INSUFFICIENT_CREDITS body as billing', () => {
		expect(
			friendlyHttpHint(
				400,
				'{"err_code":"INSUFFICIENT_CREDITS"}',
			).toLowerCase(),
		).toContain('quota or credit');
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

	it('reports a rate limit for a plain 429 with no billing markers', () => {
		expect(
			friendlyHttpHint(429, 'Too Many Requests, slow down').toLowerCase(),
		).toContain('rate limit');
	});

	it('reports a provider server error for 5xx', () => {
		expect(
			friendlyHttpHint(503, 'Service Unavailable').toLowerCase(),
		).toContain('server error');
	});

	it('names the region for a Gemini FAILED_PRECONDITION 400', () => {
		// The status says the request was malformed and it was not: the service
		// does not serve the caller's country, which no key and no retry fix.
		// Left unrecognized, the whole envelope was shown and the one sentence
		// that mattered was buried in it.
		const hint = friendlyHttpHint(
			400,
			'{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
		).toLowerCase();

		expect(hint).toContain('does not serve your region');
		// Both ways out are named: another engine, or an endpoint that does
		// serve the caller. The second is what a user in a blocked country
		// already relies on, and it is a field on the same page.
		expect(hint).toContain('engines');
		expect(hint).toContain('base url');
	});

	it('names the region for an OpenAI unsupported-country 403', () => {
		// Same refusal, a status the auth branch would otherwise claim, so the
		// region check has to be asked first.
		const hint = friendlyHttpHint(
			403,
			'{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}',
		).toLowerCase();

		expect(hint).toContain('does not serve your region');
		expect(hint).not.toContain('authentication failed');
	});

	it('returns no hint for an unrecognized client error', () => {
		expect(friendlyHttpHint(404, 'Not Found')).toBe('');
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
		__setRequestUrlHandler(() => ({
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
		__setRequestUrlHandler(() => ({
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
