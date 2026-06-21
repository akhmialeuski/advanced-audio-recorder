/**
 * Tests for friendlyHttpHint (human-readable guidance for common provider
 * HTTP failures) and uploadTimeoutMs (the payload-scaled request deadline
 * that keeps a large but healthy upload from being aborted prematurely).
 */

import {
	friendlyHttpHint,
	uploadTimeoutMs,
} from 'src/transcription/httpClient';
import {
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_REQUEST_TIMEOUT_MS,
} from 'src/constants';

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

	it('returns no hint for an unrecognized client error', () => {
		expect(friendlyHttpHint(404, 'Not Found')).toBe('');
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

	it('is monotonic in payload size', () => {
		expect(uploadTimeoutMs(10 * 1024 * 1024)).toBeLessThanOrEqual(
			uploadTimeoutMs(20 * 1024 * 1024),
		);
	});
});
