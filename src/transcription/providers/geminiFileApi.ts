/**
 * Gemini File API helpers: upload an audio file with the resumable protocol,
 * poll until it is ACTIVE, and delete it afterwards. Isolated from the provider
 * so the network steps stay testable-by-eye and the provider reads as a
 * straight-line orchestration. The upload-start step needs a response header
 * (`x-goog-upload-url`), so it uses `requestRaw` — which returns the raw
 * response after asserting success — while the body steps use `requestJson`.
 * @module transcription/providers/geminiFileApi
 */

import {
	GEMINI_FILE_MAX_WAIT_MS,
	GEMINI_FILE_POLL_INTERVAL_MS,
} from '../../constants';
import {
	HttpError,
	requestJson,
	requestRaw,
	trimTrailingSlash,
	uploadTimeoutMs,
} from '../httpClient';
import { delay } from '../../utils/TimeUtils';
import { isRecord } from './responseUtils';

/** A reference to a file uploaded to the Gemini File API. */
export interface GeminiFile {
	/** Resource name, e.g. "files/abc-123" (used for status and delete). */
	name: string;
	/** File URI referenced from a `generateContent` request. */
	uri: string;
	/** Processing state: PROCESSING, ACTIVE, or FAILED. */
	state: string;
}

/** Status used for failures that never reached an HTTP response. */
const NO_HTTP_STATUS = 0;

const FILE_STATE_ACTIVE = 'ACTIVE';
const FILE_STATE_PROCESSING = 'PROCESSING';
const FILE_STATE_FAILED = 'FAILED';

/** Reads a header case-insensitively from a `requestUrl` response. */
function readHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) {
			return headers[key];
		}
	}
	return undefined;
}

/**
 * Narrows a parsed file payload to a {@link GeminiFile}. The upload-finalize
 * response wraps the file in `{ file: {...} }`; the status GET returns the file
 * object directly — both are handled.
 */
function parseFile(body: unknown): GeminiFile {
	const file = isRecord(body) && isRecord(body.file) ? body.file : body;
	if (
		!isRecord(file) ||
		typeof file.name !== 'string' ||
		typeof file.uri !== 'string'
	) {
		throw new HttpError(
			NO_HTTP_STATUS,
			'Gemini File API returned an unexpected file response.',
		);
	}
	return {
		name: file.name,
		uri: file.uri,
		state:
			typeof file.state === 'string' ? file.state : FILE_STATE_PROCESSING,
	};
}

/**
 * Uploads audio bytes via the resumable File API protocol and returns the file
 * reference (which may still be PROCESSING — poll with {@link waitUntilActive}).
 * @param baseUrl - Gemini base URL (no version segment)
 * @param apiKey - Gemini API key
 * @param data - Encoded audio bytes
 * @param mimeType - MIME type of the bytes
 * @param displayName - Human-readable name stored with the file
 */
export async function uploadFile(
	baseUrl: string,
	apiKey: string,
	data: ArrayBuffer,
	mimeType: string,
	displayName: string,
): Promise<GeminiFile> {
	const base = trimTrailingSlash(baseUrl);
	const numBytes = String(data.byteLength);
	// Step 1: start a resumable session; the upload URL is returned in a
	// response header, so call requestUrl directly to read it.
	const start = await requestRaw({
		url: `${base}/upload/v1beta/files`,
		method: 'POST',
		headers: {
			'x-goog-api-key': apiKey,
			'X-Goog-Upload-Protocol': 'resumable',
			'X-Goog-Upload-Command': 'start',
			'X-Goog-Upload-Header-Content-Length': numBytes,
			'X-Goog-Upload-Header-Content-Type': mimeType,
		},
		contentType: 'application/json',
		body: JSON.stringify({ file: { display_name: displayName } }),
	});
	const uploadUrl = readHeader(start.headers, 'x-goog-upload-url');
	if (!uploadUrl) {
		throw new HttpError(
			start.status,
			'Gemini upload did not return an upload URL.',
		);
	}
	// Step 2: send the bytes and finalize in one request.
	const finalized = await requestJson<unknown>({
		url: uploadUrl,
		method: 'POST',
		headers: {
			'X-Goog-Upload-Offset': '0',
			'X-Goog-Upload-Command': 'upload, finalize',
		},
		body: data,
		timeoutMs: uploadTimeoutMs(data.byteLength),
	});
	return parseFile(finalized);
}

/**
 * Polls a file's status until it is ACTIVE, throwing on FAILED or when the
 * overall wait budget is exhausted.
 * @param baseUrl - Gemini base URL (no version segment)
 * @param apiKey - Gemini API key
 * @param fileName - File resource name (e.g. "files/abc-123")
 */
export async function waitUntilActive(
	baseUrl: string,
	apiKey: string,
	fileName: string,
): Promise<void> {
	const base = trimTrailingSlash(baseUrl);
	const deadline = Date.now() + GEMINI_FILE_MAX_WAIT_MS;
	for (;;) {
		const file = parseFile(
			await requestJson<unknown>({
				url: `${base}/v1beta/${fileName}`,
				method: 'GET',
				headers: { 'x-goog-api-key': apiKey },
			}),
		);
		if (file.state === FILE_STATE_ACTIVE) {
			return;
		}
		if (file.state === FILE_STATE_FAILED) {
			throw new HttpError(
				NO_HTTP_STATUS,
				'Gemini failed to process the uploaded audio file.',
			);
		}
		if (Date.now() >= deadline) {
			throw new HttpError(
				NO_HTTP_STATUS,
				'Timed out waiting for Gemini to process the uploaded audio file.',
			);
		}
		await delay(GEMINI_FILE_POLL_INTERVAL_MS);
	}
}

/**
 * Deletes an uploaded file. Best-effort: a left-over file expires on Google's
 * side, so the caller may ignore failures.
 * @param baseUrl - Gemini base URL (no version segment)
 * @param apiKey - Gemini API key
 * @param fileName - File resource name (e.g. "files/abc-123")
 */
export async function deleteFile(
	baseUrl: string,
	apiKey: string,
	fileName: string,
): Promise<void> {
	await requestRaw({
		url: `${trimTrailingSlash(baseUrl)}/v1beta/${fileName}`,
		method: 'DELETE',
		headers: { 'x-goog-api-key': apiKey },
	});
}
