/**
 * Thin HTTP helpers built on Obsidian's `requestUrl`, which bypasses the
 * renderer's CORS restrictions so the plugin can call provider APIs
 * directly. Includes a multipart/form-data builder for file uploads.
 * @module transcription/httpClient
 */

import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import {
	MS_PER_SECOND,
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_UPLOAD_BYTES_PER_MS,
} from '../constants';
import { randomToken } from '../utils/ids';
import { scaledTimeoutMs } from '../utils/TimeUtils';
import { isRecord } from '../utils/objects';

/** One field of a multipart/form-data body. */
export type MultipartField =
	| { type: 'text'; name: string; value: string }
	| {
			type: 'file';
			name: string;
			filename: string;
			contentType: string;
			data: ArrayBuffer;
	  };

/** A built multipart body and its content type (with boundary). */
export interface MultipartBody {
	body: ArrayBuffer;
	contentType: string;
}

/**
 * Builds a multipart/form-data body from text and file fields.
 * @param fields - Ordered fields
 * @returns The encoded body and the matching content-type header value
 */
export function buildMultipart(fields: MultipartField[]): MultipartBody {
	const boundary = `----aar${randomToken()}${String(Date.now())}`;
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const pushText = (text: string): void => {
		chunks.push(encoder.encode(text));
	};
	for (const field of fields) {
		pushText(`--${boundary}\r\n`);
		if (field.type === 'text') {
			pushText(
				`Content-Disposition: form-data; name="${sanitizeHeaderParam(field.name)}"\r\n\r\n`,
			);
			// Strip CR/LF so a stray newline in a user-set value (model id,
			// language) cannot inject extra multipart headers or parts.
			pushText(`${field.value.replace(/[\r\n]+/g, ' ')}\r\n`);
		} else {
			pushText(
				`Content-Disposition: form-data; name="${sanitizeHeaderParam(field.name)}"; filename="${sanitizeHeaderParam(field.filename)}"\r\n`,
			);
			pushText(`Content-Type: ${field.contentType}\r\n\r\n`);
			chunks.push(new Uint8Array(field.data));
			pushText('\r\n');
		}
	}
	pushText(`--${boundary}--\r\n`);

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		body: body.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/**
 * An authorization header, or nothing at all when there is no key.
 *
 * The endpoint decides whether a key is needed (see `accountRequiresKey`), and
 * a run against a local server has none. Sending the header anyway meant a bare
 * `Bearer ` or an empty `x-goog-api-key`: a header that claims an identity
 * which does not exist. Every provider builds its own header object, and each
 * of them asks here rather than restating the condition.
 * @param name - Header the provider carries its key in
 * @param key - The configured key, possibly empty
 * @param scheme - Scheme the value is prefixed with, e.g. `Bearer`, joined to
 *   the key with a single space; omitted for a header that is the bare key
 * @returns The single header, or an empty object
 */
export function authHeader(
	name: string,
	key: string,
	scheme = '',
): Record<string, string> {
	// The scheme is applied here rather than by the caller, because a caller
	// that formats first hands over `Bearer ` with nothing after it, which is
	// exactly the header this exists to leave out. The separator is this
	// function's too, so a caller cannot hand over `Bearerabc` - a header no
	// endpoint accepts and nothing here could tell apart from a key.
	return key ? { [name]: scheme ? `${scheme} ${key}` : key } : {};
}

/** Removes a single trailing slash from a base URL. */
export function trimTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Scales a request timeout with the upload size so a large but healthy
 * upload (e.g. a whole-file Deepgram request) is not aborted prematurely.
 * Starts at the floor and adds time proportional to the payload at a
 * conservative assumed throughput, capped at `maxMs`.
 * @param byteLength - Size of the request body in bytes
 * @param maxMs - Hard cap for the timeout (the user-configured per-request
 *   limit); defaults to {@link TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS}
 * @returns Timeout in milliseconds
 */
export function uploadTimeoutMs(
	byteLength: number,
	maxMs: number = TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
): number {
	return scaledTimeoutMs(byteLength, {
		floorMs: TRANSCRIBE_REQUEST_TIMEOUT_MS,
		bytesPerMs: TRANSCRIBE_UPLOAD_BYTES_PER_MS,
		maxMs,
	});
}

/** Status used for errors that never reached an HTTP response (transport/timeout). */
const NO_HTTP_STATUS = 0;

/** Maximum length of a response-body excerpt embedded in an error message. */
const ERROR_BODY_EXCERPT_LENGTH = 500;

/** Lowest 2xx success status (inclusive). */
const HTTP_OK_MIN = 200;

/** First status above the 2xx success range (exclusive upper bound). */
const HTTP_OK_MAX_EXCLUSIVE = 300;

/** Authentication failed (bad or missing key). */
const HTTP_UNAUTHORIZED = 401;

/** Payment required - always a billing/quota problem. */
const HTTP_PAYMENT_REQUIRED = 402;

/** Forbidden (the key lacks access). */
const HTTP_FORBIDDEN = 403;

/** Too many requests (rate limited). */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Lowest 5xx server-error status. */
const HTTP_SERVER_ERROR_MIN = 500;

/**
 * Body substrings that signal an out-of-quota / billing problem (any provider).
 * Deliberately specific (e.g. `insufficient_quota`, `credit balance`) rather than
 * bare `insufficient`/`credit`, so an auth message like "insufficient permissions"
 * on a 403 is not misread as a billing problem and is left to the auth branch.
 */
const QUOTA_BODY_MARKERS = [
	'quota',
	'insufficient_quota',
	'insufficient_credits',
	'insufficient credits',
	'credit balance',
	'billing',
];

/**
 * Body substrings that signal the service does not serve the caller's country.
 *
 * A refusal no key, no model, and no retry can fix, and one the provider states
 * plainly while the status code does not: Gemini answers 400 with
 * `FAILED_PRECONDITION` and "User location is not supported for the API use",
 * which reads as a malformed request unless the body is looked at.
 */
const REGION_BODY_MARKERS = [
	// Gemini's own wording is "User location is not supported for the API use",
	// which this shorter fragment already covers: the match is a substring test,
	// so a longer phrase beside it could never be the one that fires.
	'location is not supported',
	'country, region, or territory not supported',
	'unsupported_country_region_territory',
];

/**
 * Strips a quoted multipart header parameter of the characters that could
 * break out of the quoted value - `"`, CR, and LF - mirroring the CR/LF
 * stripping applied to text-field values, so a name or filename can never
 * inject extra parts or headers regardless of its source.
 * @param value - Raw parameter value
 */
function sanitizeHeaderParam(value: string): string {
	return value.replace(/["\r\n]+/g, ' ');
}

/**
 * Drops the query string from a URL so secrets a caller may have placed
 * there (e.g. an API key as a query param) never leak into a user-visible
 * error message.
 * @param url - Full request URL
 */
function urlForMessage(url: string): string {
	const queryStart = url.indexOf('?');
	return queryStart >= 0 ? url.slice(0, queryStart) : url;
}

/** Error thrown when a request fails (non-2xx status, transport, or timeout). */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/**
		 * Whether sending the same request again could succeed. True only for
		 * the temporary refusals - a rate limit, a provider fault - and never
		 * for a bad key, an exhausted quota, or a region the service does not
		 * serve, which a retry would only pay for twice.
		 */
		readonly retryable: boolean = false,
		/**
		 * The pause the provider asked for through `Retry-After`, in
		 * milliseconds, when it named one. Undefined leaves the caller to
		 * choose its own backoff.
		 */
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'HttpError';
	}
}

/**
 * Reads the pause a provider asked for, in milliseconds.
 *
 * The header comes in two forms by specification: a whole number of seconds,
 * or an HTTP date to wait until. A date already in the past means the wait is
 * over, which is the same as having asked for nothing.
 * @param headers - The response headers as they arrived
 * @returns The requested pause, or undefined when none was named
 */
function retryAfterMs(headers: Record<string, string>): number | undefined {
	const raw = Object.entries(headers).find(
		([name]) => name.toLowerCase() === 'retry-after',
	)?.[1];
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw.trim());
	if (Number.isFinite(seconds) && seconds > 0) {
		return seconds * MS_PER_SECOND;
	}
	const until = Date.parse(raw);
	if (Number.isNaN(until)) {
		return undefined;
	}
	const wait = until - Date.now();
	return wait > 0 ? wait : undefined;
}

/**
 * Races a request against a timeout. Obsidian's `requestUrl` exposes no
 * abort signal, so the underlying request keeps running after a timeout;
 * rejecting here lets the caller (and UI) recover instead of hanging.
 * @param request - The in-flight request promise
 * @param timeoutMs - Deadline in milliseconds
 * @param safeUrl - Query-stripped URL for the timeout message
 */
function withTimeout(
	request: Promise<RequestUrlResponse>,
	timeoutMs: number,
	safeUrl: string,
): Promise<RequestUrlResponse> {
	return new Promise<RequestUrlResponse>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(
				new HttpError(
					NO_HTTP_STATUS,
					`Request to ${safeUrl} timed out after ${String(timeoutMs)} ms.`,
				),
			);
		}, timeoutMs);
		request.then(
			(response) => {
				window.clearTimeout(timer);
				resolve(response);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			},
		);
	});
}

/**
 * The response surface both transports provide. Structurally a subset of
 * Obsidian's RequestUrlResponse, so the requestUrl path returns its
 * response unchanged while the fetch path builds a compatible object.
 */
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

/**
 * Performs the request through `fetch`, which - unlike `requestUrl` -
 * honors an AbortSignal, so pressing Cancel releases the socket and the
 * in-flight request body immediately instead of after the timeout. The
 * timeout aborts through the same controller. Only usable against
 * endpoints that allow browser (CORS) requests; the caller falls back to
 * `requestUrl` when the endpoint refuses.
 * @param options - Request options (signal set by the caller)
 * @param timeoutMs - Deadline in milliseconds
 * @param safeUrl - Query-stripped URL for error messages
 */
async function fetchResponse(
	options: RequestOptions,
	timeoutMs: number,
	safeUrl: string,
): Promise<HttpResponse> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = window.setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const outer = options.signal;
	const onOuterAbort = (): void => {
		controller.abort();
	};
	if (outer?.aborted) {
		controller.abort();
	} else {
		outer?.addEventListener('abort', onOuterAbort);
	}
	try {
		const headers: Record<string, string> = { ...options.headers };
		if (options.contentType) {
			headers['Content-Type'] = options.contentType;
		}
		// window.fetch (not requestUrl) is deliberate here: requestUrl cannot
		// abort an in-flight request, whereas fetch honors the AbortSignal.
		// CORS-refusing endpoints fall back to requestUrl in dispatchRequest.
		// Accessing it through window keeps it off the no-restricted-globals
		// ban without an inline eslint-disable.
		const response = await window.fetch(options.url, {
			method: options.method,
			headers,
			...(options.body === undefined ? {} : { body: options.body }),
			signal: controller.signal,
		});
		const text = await response.text();
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});
		return { status: response.status, headers: responseHeaders, text };
	} catch (error) {
		if (controller.signal.aborted) {
			throw new HttpError(
				NO_HTTP_STATUS,
				timedOut
					? `Request to ${safeUrl} timed out after ${String(timeoutMs)} ms.`
					: `Request to ${safeUrl} was cancelled.`,
			);
		}
		throw error;
	} finally {
		window.clearTimeout(timer);
		outer?.removeEventListener('abort', onOuterAbort);
	}
}

/**
 * Origins that answered a `fetch` with a network-layer refusal, which for an
 * API endpoint is all but always CORS.
 *
 * Which transport an endpoint takes cannot be read off anything the plugin
 * holds: `requestUrl` is exempt from CORS and cannot abort, `fetch` is the
 * reverse, and only the endpoint's own answer says which one it will accept.
 * So it is asked - once. Asking per request meant a run against a
 * CORS-refusing server sent every body twice, once for the refusal and once
 * for the request that works, which on an LLM step is a whole transcript.
 * The memory lasts the session: a server whose CORS is fixed while Obsidian
 * is open is picked up on the next reload, and the cost of being wrong is a
 * request that cannot be aborted, which is where such an endpoint stood
 * before it was ever tried.
 */
const corsRefusingOrigins = new Set<string>();

/**
 * The origin a request belongs to, or null for a URL that does not parse -
 * about which nothing is remembered, since it has no origin to remember.
 * @param url - Full request URL
 */
function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Chooses the transport for one request: abortable `fetch` when a signal
 * was provided, otherwise Obsidian's CORS-exempt `requestUrl`. A fetch
 * that fails at the network layer (typically a CORS rejection from an
 * OpenAI-compatible endpoint that only expects server-side clients) is
 * retried once through `requestUrl` - re-sending the body, but that
 * matches the pre-abort behavior where every request went that way - and
 * that origin is not asked again for the rest of the session.
 * @param options - Request options
 * @param timeoutMs - Deadline in milliseconds
 * @param safeUrl - Query-stripped URL for error messages
 */
async function dispatchRequest(
	options: RequestOptions,
	timeoutMs: number,
	safeUrl: string,
): Promise<HttpResponse> {
	const origin = originOf(options.url);
	const abortable =
		options.signal !== undefined &&
		!(origin !== null && corsRefusingOrigins.has(origin));
	if (abortable) {
		try {
			return await fetchResponse(options, timeoutMs, safeUrl);
		} catch (error) {
			// An HttpError here is a timeout or cancel - final either way. A
			// TypeError is fetch's network-layer failure (CORS/DNS/refused);
			// only then is requestUrl worth a try.
			if (error instanceof HttpError || !(error instanceof TypeError)) {
				throw error;
			}
			if (origin !== null) {
				corsRefusingOrigins.add(origin);
			}
		}
	}
	return withTimeout(
		requestUrl({
			url: options.url,
			method: options.method,
			...(options.headers === undefined
				? {}
				: { headers: options.headers }),
			...(options.body === undefined ? {} : { body: options.body }),
			...(options.contentType === undefined
				? {}
				: { contentType: options.contentType }),
			throw: false,
		}),
		timeoutMs,
		safeUrl,
	);
}

/**
 * Maps an HTTP failure to a short, human-readable hint for the common cases -
 * out of quota/credit, bad key, rate limit, provider outage - or '' when no
 * specific guidance applies. Provider-neutral: matches OpenAI
 * `insufficient_quota`, Anthropic "credit balance is too low", and Deepgram
 * `INSUFFICIENT_CREDITS` alike. The caller still appends the raw status and
 * body excerpt for diagnostics.
 * @param status - HTTP status code (0 for transport/timeout failures)
 * @param body - Response body excerpt (may be empty)
 * @returns A human-readable hint, or '' when none applies
 */
export function friendlyHttpHint(status: number, body: string): string {
	return classifyHttpFailure(status, body).hint;
}

/** What one HTTP failure is, as far as the run is concerned. */
interface HttpFailureKind {
	/** Human-readable guidance, or '' when none applies. */
	readonly hint: string;
	/** Whether sending the same request again could succeed. */
	readonly retryable: boolean;
}

/**
 * Decides what a failure is: what to tell the user, and whether the run should
 * try the same request again.
 *
 * The two answers come from the same branches on purpose. The plugin already
 * recognised a rate limit well enough to advise waiting and retrying; deciding
 * separately whether to retry would be a second reading of the same response,
 * free to disagree with the first. So the branch that says "wait a moment and
 * try again" is the branch that says the run may.
 * @param status - HTTP status code (0 for transport/timeout failures)
 * @param body - Response body excerpt (may be empty)
 */
function classifyHttpFailure(status: number, body: string): HttpFailureKind {
	const lower = body.toLowerCase();
	// Before the billing and auth branches: a region refusal arrives on a
	// status those branches would otherwise claim, and it is neither.
	if (REGION_BODY_MARKERS.some((marker) => lower.includes(marker))) {
		// Two ways out, and the second is the one a user in a blocked country
		// already relies on: the same page holds the endpoint, so a request can
		// be sent somewhere that does serve them.
		return {
			hint:
				'This provider does not serve your region. Under Engines, either ' +
				'pick a different engine for this job, or point this one at an ' +
				'endpoint that serves you via its Base URL.',
			retryable: false,
		};
	}
	const looksLikeBilling =
		status === HTTP_PAYMENT_REQUIRED ||
		QUOTA_BODY_MARKERS.some((marker) => lower.includes(marker));
	if (looksLikeBilling) {
		// A quota that ran out arrives shaped like a rate limit and is fixed by
		// nothing a retry can do, so this branch stands ahead of that one.
		return {
			hint:
				'Out of API quota or credit. Check the provider plan and billing ' +
				'details - a chat subscription (e.g. ChatGPT Plus) does not include ' +
				'API credit.',
			retryable: false,
		};
	}
	if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
		return {
			hint:
				'Authentication failed. Check that the API key is correct and ' +
				'authorized for this provider.',
			retryable: false,
		};
	}
	if (
		status === HTTP_TOO_MANY_REQUESTS ||
		lower.includes('rate limit') ||
		lower.includes('too many requests')
	) {
		return {
			hint: 'Rate limit reached. Wait a moment and try again.',
			retryable: true,
		};
	}
	if (status >= HTTP_SERVER_ERROR_MIN) {
		return {
			hint: 'The provider had a server error. Try again shortly.',
			retryable: true,
		};
	}
	return { hint: '', retryable: false };
}

/**
 * What a provider said went wrong, taken out of the envelope it said it in.
 *
 * Every service the plugin calls answers a failure with JSON carrying one
 * human sentence and a pile of machine fields around it: Google nests it under
 * `error.message`, OpenAI and Anthropic the same, Deepgram calls it `err_msg`.
 * Showing the envelope makes the reader find that sentence among braces and
 * request ids, in a Notice that disappears while they are still reading. The
 * sentence alone is what a person can act on; the rest is in the console log
 * with the error.
 * @param body - Response body excerpt
 * @returns The provider's own message, or the excerpt when there is none
 */
export function providerMessage(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (!isRecord(parsed)) {
			return body;
		}
		const error = parsed.error;
		const message = isRecord(error) ? error.message : undefined;
		for (const candidate of [message, parsed.err_msg, parsed.message]) {
			if (typeof candidate === 'string' && candidate.trim() !== '') {
				return candidate;
			}
		}
		return body;
	} catch {
		// Not JSON at all (an HTML error page, a proxy banner, a truncated
		// excerpt): there is no sentence to lift out, so it is shown as it came.
		return body;
	}
}

/** Options shared by {@link requestRaw} and {@link requestJson}. */
export interface RequestOptions {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	/** Per-request deadline; defaults to the transcription floor timeout. */
	timeoutMs?: number;
	/**
	 * Optional abort signal. When set, the request is sent through `fetch`
	 * (which can actually abort mid-flight) so a Cancel releases the socket
	 * and request body immediately. Endpoints that refuse browser (CORS)
	 * requests fall back to `requestUrl`, which cannot abort - there the
	 * request keeps running until the timeout, as before.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Performs a request and returns the raw response after asserting success.
 * Normalizes a non-2xx status (with a trimmed body excerpt and a friendly
 * hint), a transport failure, and a timeout into an {@link HttpError}, and
 * never echoes secrets in the URL query string. Use this over
 * {@link requestJson} only when the caller needs the raw response (e.g. to
 * read a response header that the JSON helper does not expose); otherwise
 * prefer {@link requestJson}.
 * @param options - Request options (throw is disabled internally)
 * @returns The successful (2xx) response
 */
export async function requestRaw(
	options: RequestOptions,
): Promise<HttpResponse> {
	const safeUrl = urlForMessage(options.url);
	const timeoutMs = options.timeoutMs ?? TRANSCRIBE_REQUEST_TIMEOUT_MS;
	let response: HttpResponse;
	try {
		response = await dispatchRequest(options, timeoutMs, safeUrl);
	} catch (error) {
		if (error instanceof HttpError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new HttpError(
			NO_HTTP_STATUS,
			`Request to ${safeUrl} failed: ${message}`,
		);
	}
	if (
		response.status < HTTP_OK_MIN ||
		response.status >= HTTP_OK_MAX_EXCLUSIVE
	) {
		const excerpt = (response.text || '').slice(
			0,
			ERROR_BODY_EXCERPT_LENGTH,
		);
		// Classified on the whole excerpt, because what it looks for is as
		// likely to be in a status field as in the message. Done here, where
		// the status, the body, and the headers are all still in hand.
		const { hint, retryable } = classifyHttpFailure(
			response.status,
			excerpt,
		);
		const detail = `Request to ${safeUrl} failed with status ${String(response.status)}: ${providerMessage(excerpt)}`;
		throw new HttpError(
			response.status,
			hint ? `${hint} (${detail})` : detail,
			retryable,
			retryAfterMs(response.headers),
		);
	}
	return response;
}

/**
 * Performs a request and parses the JSON body. Normalizes every failure
 * mode into an {@link HttpError}: a non-2xx status (with a trimmed body
 * excerpt), a transport failure, a timeout, and a 2xx body that is not
 * valid JSON. Secrets in the URL query string are never echoed.
 * @param options - Request options (throw is disabled internally)
 * @returns Parsed JSON body
 */
export async function requestJson<T = unknown>(
	options: RequestOptions,
): Promise<T> {
	const response = await requestRaw(options);
	// Parse the body defensively: a 2xx with an empty/HTML/truncated body
	// would otherwise throw a raw SyntaxError that is not an HttpError.
	try {
		return JSON.parse(response.text) as T;
	} catch {
		throw new HttpError(
			response.status,
			`Request to ${urlForMessage(options.url)} returned a non-JSON response.`,
		);
	}
}
