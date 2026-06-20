/**
 * Thin HTTP helpers built on Obsidian's `requestUrl`, which bypasses the
 * renderer's CORS restrictions so the plugin can call provider APIs
 * directly. Includes a multipart/form-data builder for file uploads.
 * @module transcription/httpClient
 */

import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';

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
				`Content-Disposition: form-data; name="${field.name}"\r\n\r\n`,
			);
			// Strip CR/LF so a stray newline in a user-set value (model id,
			// language) cannot inject extra multipart headers or parts.
			pushText(`${field.value.replace(/[\r\n]+/g, ' ')}\r\n`);
		} else {
			pushText(
				`Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`,
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

/** Error thrown when a provider returns a non-2xx response. */
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
 * Performs a request and parses the JSON body, throwing HttpError on a
 * non-2xx status with a trimmed body excerpt for diagnostics.
 * @param options - requestUrl options (with throw disabled internally)
 * @returns Parsed JSON body
 */
export async function requestJson<T = unknown>(options: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}): Promise<T> {
	const response: RequestUrlResponse = await requestUrl({
		url: options.url,
		method: options.method,
		headers: options.headers,
		body: options.body,
		contentType: options.contentType,
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		const excerpt = (response.text || '').slice(0, 500);
		throw new HttpError(
			response.status,
			`Request to ${options.url} failed with status ${String(response.status)}: ${excerpt}`,
		);
	}
	return response.json as T;
}
