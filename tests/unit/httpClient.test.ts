/**
 * Tests for what a failed request carries out of the HTTP client - the
 * human-readable guidance and whether the run may send it again, both read off
 * the HttpError the client throws - and for uploadTimeoutMs, the
 * payload-scaled request deadline that keeps a large but healthy upload from
 * being aborted prematurely.
 */

import {
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
import { captureRequests, withRequestUrl } from '../helpers/network';
import { flushMicrotasks } from '../helpers/async';
import { defined } from '../helpers/assertions';

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

describe('requestRaw abort support', () => {
	afterEach(() => {
		delete (globalThis as { fetch?: unknown }).fetch;
		// Restored here rather than at the end of the one test that installs
		// fake timers: a failing assertion there would otherwise leave them
		// running for every test after it in this block.
		jest.useRealTimers();
	});

	/** What a real fetch rejects with once its signal aborts. */
	function abortError(): DOMException {
		return new DOMException('The operation was aborted.', 'AbortError');
	}

	/**
	 * Installs a fetch double that answers with `impl` and, like the real
	 * thing, rejects the moment its signal aborts, whatever the endpoint is
	 * doing. A double that only resolves would leave the caller waiting on a
	 * request the browser has already dropped, which is the one behaviour the
	 * abortable transport exists for.
	 * @param impl - What the endpoint answers with
	 * @returns The double, for counting what it was asked to send
	 */
	function mockFetch(impl: (typeof globalThis)['fetch']): jest.Mock {
		const mock = jest.fn(((url, init) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				return Promise.reject(abortError());
			}
			const answer = impl(url, init);
			if (!signal) {
				return answer;
			}
			return Promise.race([
				answer,
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener('abort', () => {
						reject(abortError());
					});
				}),
			]);
		}) as (typeof globalThis)['fetch']);
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

	/** The calls a fetch double was asked to make that carried a body. */
	function bodiesSentByFetch(fetchMock: jest.Mock): unknown[] {
		return fetchMock.mock.calls.filter(
			(call) => (call[1] as { body?: unknown } | undefined)?.body,
		);
	}

	/**
	 * Puts the CORS-exempt transport behind the endpoint, answering with a
	 * body that names itself. Which transport carried a request is the whole
	 * question in this block, so every case that has a fallback to reach needs
	 * the same double and tells it apart by that name.
	 */
	function fallbackAnswers(): void {
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: '{"via":"requestUrl"}',
		}));
	}

	// Each of these owns its host name: what an origin does with a browser
	// request is learned once and remembered for the session, so two tests
	// sharing a host would be reading each other's answer.
	it('sends the request through fetch when a signal is provided', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(
				fakeResponse(200, '{"ok":true}', { 'x-test': 'yes' }),
			),
		);

		const response = await requestRaw({
			url: 'https://takes-fetch.example.com/v1/transcribe',
			method: 'POST',
			body: 'payload',
			signal: new AbortController().signal,
		});

		expect(bodiesSentByFetch(fetchMock)).toHaveLength(1);
		expect(response.status).toBe(200);
		expect(response.text).toBe('{"ok":true}');
		expect(response.headers['x-test']).toBe('yes');
	});

	// The probe is what keeps the discovery off the request: it asks the same
	// URL with no body, so a refusal costs a round trip instead of an upload.
	it('asks an unknown origin with a bodyless request first', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(fakeResponse(200, '{}')),
		);

		await requestRaw({
			url: 'https://asked-first.example.com/v1/transcribe',
			method: 'POST',
			body: 'payload',
			signal: new AbortController().signal,
		});

		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' });
		expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
	});

	it('rejects with a cancellation HttpError when the signal aborts mid-flight', async () => {
		const controller = new AbortController();
		(globalThis as { fetch?: unknown }).fetch = fetchThatOnlyAborts();

		const pending = requestRaw({
			url: 'https://cancels-midflight.example.com/v1/transcribe',
			method: 'POST',
			signal: controller.signal,
		});
		// The probe runs before the request does, and aborting during it is a
		// different case (covered below). Letting it settle first puts the
		// cancel where this test says it is: on the request in flight.
		await flushMicrotasks();
		controller.abort();

		await expect(pending).rejects.toThrow(HttpError);
		await expect(pending).rejects.toThrow(/was cancelled/);
	});

	// The fallback transport cannot be aborted, so a run that reaches it after
	// the user pressed Cancel would upload audio nobody is waiting for. The
	// cancel is therefore answered between the probe and the request.
	it('rejects when the signal aborts while the origin is being probed', async () => {
		const controller = new AbortController();
		const fetchMock = mockFetch(() =>
			Promise.reject(new TypeError('Failed to fetch')),
		);
		const sent = captureRequests({ status: 200, text: '{}' });

		const pending = requestRaw({
			url: 'https://cancels-during-probe.example.com/v1/transcribe',
			method: 'POST',
			body: 'the audio',
			signal: controller.signal,
		});
		controller.abort();

		await expect(pending).rejects.toThrow(/was cancelled/);
		expect(bodiesSentByFetch(fetchMock)).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	/**
	 * An endpoint that refuses fetch the way a CORS-less server does, with
	 * requestUrl answering behind it.
	 * @returns The fetch double, for counting how often it was asked
	 */
	function corsRefusingEndpoint(): jest.Mock {
		const fetchMock = mockFetch(() =>
			Promise.reject(new TypeError('Failed to fetch')),
		);
		fallbackAnswers();
		return fetchMock;
	}

	/**
	 * An endpoint that answers the bodyless probe and then refuses the request
	 * behind it, which is what an Authorization header's preflight meets.
	 * @returns The fetch double, for counting how often it was asked
	 */
	function probePassingEndpoint(): jest.Mock {
		const fetchMock = mockFetch((_url: unknown, init?: RequestInit) =>
			init?.method === 'HEAD'
				? Promise.resolve(fakeResponse(200, ''))
				: Promise.reject(new TypeError('Failed to fetch')),
		);
		fallbackAnswers();
		return fetchMock;
	}

	/**
	 * Sends one abortable request to the given endpoint.
	 * @param url - Where to send it
	 * @returns The response body
	 */
	async function sendAbortable(url: string): Promise<string> {
		const response = await requestRaw({
			url,
			method: 'POST',
			signal: new AbortController().signal,
		});
		return response.text;
	}

	// The whole point of the probe. A CORS refusal reaches the browser only
	// after the server has taken the upload, decoded it and billed it, so
	// discovering the refusal with the request itself paid for the audio
	// twice. The probe carries no body, so it cannot.
	it('sends the body once to an endpoint that refuses browser requests', async () => {
		const fetchMock = mockFetch(() =>
			Promise.reject(new TypeError('Failed to fetch')),
		);
		const sent = captureRequests({ status: 200, text: '{}' });

		await requestRaw({
			url: 'https://billed-twice.example.com/v1/transcribe',
			method: 'POST',
			body: 'the audio',
			signal: new AbortController().signal,
		});

		expect(bodiesSentByFetch(fetchMock)).toHaveLength(0);
		expect(
			sent.filter((request) => request.body === 'the audio'),
		).toHaveLength(1);
	});

	// A probe that passed does not promise the request will: the real one
	// carries an Authorization header and so a preflight of its own, which the
	// endpoint may refuse. That refusal costs nothing, because the body is not
	// sent, but the run still has to reach the transport that works.
	it('falls back when the request is refused after the probe passed', async () => {
		const fetchMock = probePassingEndpoint();

		const body = await sendAbortable(
			'https://preflight-refused.example.com/v1/transcribe',
		);

		expect(body).toBe('{"via":"requestUrl"}');
		// The probe and the request it cleared: both were tried, and the
		// fallback is what answered.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// A probe that could not be read is not a refusal. fetch reports a CORS
	// refusal and a dropped link as the same opaque TypeError, so a failed
	// probe says only that the question went unanswered, and requestUrl
	// answering afterwards speaks to reachability rather than to CORS. Writing
	// a refusal from the two together cost the origin its abortable transport
	// for the session, so Cancel stopped releasing anything - over a link that
	// was back by the very next request.
	it('asks again after a probe that could not be read', async () => {
		let probes = 0;
		const fetchMock = mockFetch((_url: unknown, init?: RequestInit) => {
			if (init?.method !== 'HEAD') {
				return Promise.resolve(fakeResponse(200, '{"via":"fetch"}'));
			}
			probes += 1;
			// Unreachable for the first probe, answering by the second.
			return probes === 1
				? Promise.reject(new TypeError('Failed to fetch'))
				: Promise.resolve(fakeResponse(200, ''));
		});
		fallbackAnswers();
		const url = 'https://probe-blipped.example.com/v1/transcribe';

		const first = await sendAbortable(url);
		const second = await sendAbortable(url);

		// The first request keeps its body off a transport that might refuse
		// it; the second finds the origin still unanswered, asks again, and
		// gets the abortable transport back.
		expect(first).toBe('{"via":"requestUrl"}');
		expect(second).toBe('{"via":"fetch"}');
		expect(probes).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	// The probe answers on its own deadline rather than the request's, which
	// can be an hour: a host that cannot say hello in ten seconds is answered
	// through requestUrl, which is where an unknown host was headed anyway.
	it('gives up on a probe that never answers and uses the fallback', async () => {
		jest.useFakeTimers();
		const fetchMock = mockFetch(() => new Promise(() => undefined));
		fallbackAnswers();

		const settled = sendAbortable(
			'https://silent-probe.example.com/v1/transcribe',
		);
		await jest.advanceTimersByTimeAsync(10_000);

		expect(await settled).toBe('{"via":"requestUrl"}');
		expect(bodiesSentByFetch(fetchMock)).toHaveLength(0);
	});

	// The one probe failure that is worth remembering. A refusal and a dropped
	// link cost a round trip to re-ask and might genuinely have changed, but a
	// host that takes the connection and says nothing has neither property:
	// asking again buys the same silence for the whole deadline, and a
	// recording split into a dozen parts paid it a dozen times over, on top of
	// each request's own limit.
	it('asks a host that never answers the probe twice, then stops', async () => {
		jest.useFakeTimers();
		const fetchMock = mockFetch(() => new Promise(() => undefined));
		fallbackAnswers();
		const url = 'https://always-silent.example.com/v1/transcribe';

		const first = sendAbortable(url);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(await first).toBe('{"via":"requestUrl"}');
		const second = sendAbortable(url);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(await second).toBe('{"via":"requestUrl"}');
		const third = sendAbortable(url);
		await flushMicrotasks();
		// Counted before the clock moves, where a third probe would still be
		// in flight. Asserting after would report the extra probe as a hung
		// request rather than as the extra probe it is.
		const probesBeforeTheClockMoved = fetchMock.mock.calls.length;
		await jest.advanceTimersByTimeAsync(10_000);

		expect(await third).toBe('{"via":"requestUrl"}');
		expect(probesBeforeTheClockMoved).toBe(2);
	});

	// One unanswered probe describes a moment, not an endpoint: a serverless
	// endpoint waking up, a local server loading a model, a link that
	// hiccupped. Read as a verdict it cost the origin its abortable transport
	// for the whole session, so Cancel stopped releasing the socket - the same
	// loss that remembering a one-off refusal used to cause.
	it('gives a host that was silent once another chance', async () => {
		jest.useFakeTimers();
		let probes = 0;
		mockFetch((_url: unknown, init?: RequestInit) => {
			if (init?.method !== 'HEAD') {
				return Promise.resolve(fakeResponse(200, '{"via":"fetch"}'));
			}
			probes += 1;
			// Too slow for the deadline once, ready by the next request.
			return probes === 1
				? new Promise<Response>(() => undefined)
				: Promise.resolve(fakeResponse(200, ''));
		});
		fallbackAnswers();
		const url = 'https://slow-to-wake.example.com/v1/transcribe';

		const first = sendAbortable(url);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(await first).toBe('{"via":"requestUrl"}');

		expect(await sendAbortable(url)).toBe('{"via":"fetch"}');
	});

	// The repeat is worth paying a bounded number of times and no more. Left
	// unbounded it could never converge: an unanswered origin skips fetch
	// altogether, so the real request never gets to earn the refusal that
	// would settle the question, and every call to a CORS-refusing endpoint
	// spent a probe that could not teach it anything for the rest of the
	// session.
	it('stops probing an origin whose probe is never readable', async () => {
		let probes = 0;
		mockFetch((_url: unknown, init?: RequestInit) => {
			if (init?.method === 'HEAD') {
				probes += 1;
			}
			return Promise.reject(new TypeError('Failed to fetch'));
		});
		fallbackAnswers();
		const url = 'https://unreadable-forever.example.com/v1/transcribe';

		await sendAbortable(url);
		await sendAbortable(url);
		await sendAbortable(url);

		expect(probes).toBe(2);
	});

	// Nothing goes out at all for a run the user has already cancelled, on
	// either transport: the probe is entered with the cancel in hand, and the
	// fallback is refused before it is reached.
	it('sends nothing when the signal was already aborted', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(fakeResponse(200, '{}')),
		);
		const sent = captureRequests({ status: 200, text: '{}' });
		const controller = new AbortController();
		controller.abort();

		await expect(
			requestRaw({
				url: 'https://already-cancelled.example.com/v1/transcribe',
				method: 'POST',
				body: 'the audio',
				signal: controller.signal,
			}),
		).rejects.toThrow(/was cancelled/);

		expect(bodiesSentByFetch(fetchMock)).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	// Same on an origin already known to take fetch, where the request goes
	// straight to the abortable transport and that transport answers it.
	it('sends nothing on a known origin when the signal was already aborted', async () => {
		mockFetch(() => Promise.resolve(fakeResponse(200, '{}')));
		const url = 'https://known-good.example.com/v1/transcribe';
		await sendAbortable(url);
		const sent = captureRequests({ status: 200, text: '{}' });
		const controller = new AbortController();
		controller.abort();

		await expect(
			requestRaw({
				url,
				method: 'POST',
				body: 'the audio',
				signal: controller.signal,
			}),
		).rejects.toThrow(/was cancelled/);

		expect(sent).toHaveLength(0);
	});

	// On its own origin, because an answer is remembered: the cases after
	// this one expect fetch to be tried, and would find it already ruled out
	// for a host this test had refused.
	it('falls back to requestUrl when fetch fails at the network layer (CORS)', async () => {
		const fetchMock = corsRefusingEndpoint();

		const body = await sendAbortable(
			'https://cors-refusing.example.com/v1/transcribe',
		);

		expect(body).toBe('{"via":"requestUrl"}');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// The discovery costs a whole request body, which on an LLM step is a
	// transcript. Paying it per call meant every request to such a server went
	// out twice for the rest of the run. A refusal the real request earned is
	// what settles the question, so it is remembered and the call after it
	// spends neither a probe nor a body on asking again.
	it('asks an origin that refused the request itself only once', async () => {
		const fetchMock = probePassingEndpoint();
		const url = 'https://remembered.example.com/v1/transcribe';

		await sendAbortable(url);
		await sendAbortable(url);

		// The probe and the request that earned the refusal, both from the
		// first call. The second went straight to the fallback.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// What the memory above exists to protect, held whatever the memory does:
	// an origin whose probe never reads keeps being asked, and no call to it
	// ever puts the body on the transport that could be made to send it twice.
	it('keeps the body off fetch on every call to a refusing origin', async () => {
		const fetchMock = corsRefusingEndpoint();
		const sent = captureRequests({ status: 200, text: '{}' });
		const url = 'https://never-readable.example.com/v1/transcribe';
		const send = (): Promise<unknown> =>
			requestRaw({
				url,
				method: 'POST',
				body: 'the audio',
				signal: new AbortController().signal,
			});

		await send();
		await send();

		expect(bodiesSentByFetch(fetchMock)).toHaveLength(0);
		expect(
			sent.filter((request) => request.body === 'the audio'),
		).toHaveLength(2);
	});

	// A CORS refusal and an unreachable network reach fetch as the same
	// opaque TypeError, so the refusal on its own proves nothing about which
	// it was. Remembering it anyway cost the origin its abortable transport
	// for the whole session - and with it every Cancel pressed against that
	// provider - over one dropped link. What tells them apart is whether the
	// fallback answered where fetch could not.
	it('keeps asking an origin whose fallback failed too', async () => {
		const fetchMock = corsRefusingEndpoint();
		withRequestUrl(() => Promise.reject(new Error('network is down')));
		const url = 'https://briefly-offline.example.com/v1/transcribe';

		await expect(sendAbortable(url)).rejects.toThrow(/network is down/);

		// The link came back, and the origin is owed its fetch: nothing was
		// ever learned about whether it takes one.
		fallbackAnswers();
		await sendAbortable(url);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// A URL with no origin to remember is simply attempted, rather than
	// tripping the memory over on a value it cannot key.
	it('attempts a URL it cannot read an origin from', async () => {
		const fetchMock = mockFetch(() =>
			Promise.resolve(fakeResponse(200, '{}')),
		);

		await requestRaw({
			url: '/relative/transcribe',
			method: 'POST',
			signal: new AbortController().signal,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
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

/**
 * A fetch that never settles until its signal aborts, then rejects.
 *
 * The bodyless probe is answered straight away: it is a different question
 * from the one this double exists to hang on, and leaving it unanswered would
 * park the client on the probe's own deadline instead of the request.
 */
function fetchThatOnlyAborts(): jest.Mock {
	return jest.fn(
		(_url: unknown, init?: { method?: string; signal?: AbortSignal }) =>
			init?.method === 'HEAD'
				? Promise.resolve({
						status: 200,
						text: () => Promise.resolve(''),
						headers: new Map<string, string>(),
					} as unknown as Response)
				: new Promise((_resolve, reject) => {
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
