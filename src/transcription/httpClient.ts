/**
 * Thin HTTP helpers built on Obsidian's `requestUrl`, which bypasses the
 * renderer's CORS restrictions so the plugin can call provider APIs
 * directly. Includes a multipart/form-data builder for file uploads.
 * @module transcription/httpClient
 */

import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { TRANSCRIBE_REQUEST_TIMEOUT_MS } from '../constants';

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
	const boundary = `----aar${Math.random().toString(16).slice(2)}${String(Date.now())}`;
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

/** Removes a single trailing slash from a base URL. */
export function trimTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Status used for errors that never reached an HTTP response (transport/timeout). */
const NO_HTTP_STATUS = 0;

/** Maximum length of a response-body excerpt embedded in an error message. */
const ERROR_BODY_EXCERPT_LENGTH = 500;

/**
 * Strips a quoted multipart header parameter of the characters that could
 * break out of the quoted value — `"`, CR, and LF — mirroring the CR/LF
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
	) {
		super(message);
		this.name = 'HttpError';
	}
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
 * Performs a request and parses the JSON body. Normalizes every failure
 * mode into an {@link HttpError}: a non-2xx status (with a trimmed body
 * excerpt), a transport failure, a timeout, and a 2xx body that is not
 * valid JSON. Secrets in the URL query string are never echoed.
 * @param options - Request options (throw is disabled internally)
 * @returns Parsed JSON body
 */
export async function requestJson<T = unknown>(options: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}): Promise<T> {
	const safeUrl = urlForMessage(options.url);
	let response: RequestUrlResponse;
	try {
		response = await withTimeout(
			requestUrl({
				url: options.url,
				method: options.method,
				headers: options.headers,
				body: options.body,
				contentType: options.contentType,
				throw: false,
			}),
			TRANSCRIBE_REQUEST_TIMEOUT_MS,
			safeUrl,
		);
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
	if (response.status < 200 || response.status >= 300) {
		const excerpt = (response.text || '').slice(
			0,
			ERROR_BODY_EXCERPT_LENGTH,
		);
		throw new HttpError(
			response.status,
			`Request to ${safeUrl} failed with status ${String(response.status)}: ${excerpt}`,
		);
	}
	// Parse the body defensively: a 2xx with an empty/HTML/truncated body
	// would otherwise throw a raw SyntaxError that is not an HttpError.
	try {
		return JSON.parse(response.text) as T;
	} catch {
		throw new HttpError(
			response.status,
			`Request to ${safeUrl} returned a non-JSON response.`,
		);
	}
}
