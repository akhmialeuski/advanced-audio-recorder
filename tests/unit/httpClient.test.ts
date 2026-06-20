/**
 * Tests for friendlyHttpHint: the human-readable guidance shown for common
 * provider HTTP failures. The regression focus is detecting an out-of-quota
 * or out-of-credit (billing) problem across providers, since that is the most
 * common and most confusing failure when a key has no funds.
 */

import { friendlyHttpHint } from 'src/transcription/httpClient';

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
