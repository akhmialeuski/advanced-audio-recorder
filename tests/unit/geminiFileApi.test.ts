/**
 * Tests for the Gemini File API helpers: the resumable upload (start then
 * finalize, including case-insensitive upload-URL header handling and the
 * default PROCESSING state), status polling that returns on ACTIVE and throws
 * on FAILED, and the best-effort delete. Obsidian's requestUrl is scripted
 * through the shared mock handler.
 */

import {
	deleteFile,
	fileProcessingWaitMs,
	uploadFile,
	waitUntilActive,
} from 'src/transcription/providers/geminiFileApi';
import { at } from '../helpers/assertions';
import {
	GEMINI_FILE_MAX_WAIT_MS,
	GEMINI_FILE_MIN_WAIT_MS,
	GEMINI_FILE_POLL_INTERVAL_MS,
} from 'src/constants';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { queueResponses, withRequestUrl } from '../helpers/network';

const BASE_URL = 'https://gemini.example';
const API_KEY = 'gm-test';

/** One status response reporting the given processing state. */
function statusResponse(state: string): MockRequestUrlResponse {
	return {
		status: 200,
		headers: {},
		text: JSON.stringify({
			name: 'files/x',
			uri: 'https://files.example/x',
			state,
		}),
	};
}

/**
 * Answers the resumable upload: the start step hands back an upload URL, the
 * finalize step hands back whatever this test wants the file to be.
 * @param finalized - Body the finalize step answers with
 */
function scriptUpload(finalized: unknown): void {
	withRequestUrl((param): MockRequestUrlResponse => {
		if (param.url.includes('/upload/')) {
			return {
				status: 200,
				headers: { 'x-goog-upload-url': 'https://up.example' },
				text: '',
			};
		}
		return { status: 200, headers: {}, text: JSON.stringify(finalized) };
	});
}

describe('uploadFile', () => {
	it('starts a resumable session then finalizes, returning the file', async () => {
		const calls: MockRequestUrlParam[] = [];
		withRequestUrl((param): MockRequestUrlResponse => {
			calls.push(param);
			if (param.url.endsWith('/upload/v1beta/files')) {
				return {
					status: 200,
					headers: {
						'X-Goog-Upload-URL': 'https://upload.example/session',
					},
					text: '',
				};
			}
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					file: {
						name: 'files/abc',
						uri: 'https://files.example/abc',
						state: 'ACTIVE',
					},
				}),
			};
		});

		const file = await uploadFile(
			BASE_URL,
			API_KEY,
			new ArrayBuffer(8),
			'audio/wav',
			'rec.wav',
		);

		expect(file).toEqual({
			name: 'files/abc',
			uri: 'https://files.example/abc',
			state: 'ACTIVE',
		});
		expect(at(calls, 0).url).toBe(`${BASE_URL}/upload/v1beta/files`);
		expect(at(calls, 0).headers?.['X-Goog-Upload-Command']).toBe('start');
		expect(at(calls, 1).url).toBe('https://upload.example/session');
		expect(at(calls, 1).headers?.['X-Goog-Upload-Command']).toBe(
			'upload, finalize',
		);
	});

	it('reads the upload URL header case-insensitively and defaults a missing state', async () => {
		scriptUpload({
			file: { name: 'files/x', uri: 'https://files.example/x' },
		});

		const file = await uploadFile(
			BASE_URL,
			API_KEY,
			new ArrayBuffer(1),
			'audio/wav',
			'a.wav',
		);

		expect(file.name).toBe('files/x');
		expect(file.state).toBe('PROCESSING');
	});

	it('throws with a friendly hint when the start step fails', async () => {
		withRequestUrl(() => ({
			status: 403,
			headers: {},
			text: 'forbidden',
		}));

		await expect(
			uploadFile(BASE_URL, API_KEY, new ArrayBuffer(1), 'audio/wav', 'a'),
		).rejects.toThrow(/authentication failed/i);
	});

	// Headers the response really does carry, so the search has something to
	// skip past: a handler answering with none at all never runs the compare.
	it('throws when the start step omits the upload URL header', async () => {
		withRequestUrl(() => ({
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Upload-Status': 'active',
			},
			text: '',
		}));

		await expect(
			uploadFile(BASE_URL, API_KEY, new ArrayBuffer(1), 'audio/wav', 'a'),
		).rejects.toThrow(/upload url/i);
	});

	it.each([
		{ name: 'is not an object', body: 'nope' },
		{ name: 'names no file', body: {} },
		{ name: 'carries a name but no uri', body: { name: 'files/x' } },
		{
			name: 'carries a uri but no name',
			body: { uri: 'https://files.example/x' },
		},
		{
			name: 'wraps a file that is itself unusable',
			body: { file: { name: 'files/x' } },
		},
	])('throws when the finalized response $name', async ({ body }) => {
		scriptUpload(body);

		await expect(
			uploadFile(BASE_URL, API_KEY, new ArrayBuffer(1), 'audio/wav', 'a'),
		).rejects.toThrow(/unexpected file response/i);
	});
});

describe('waitUntilActive', () => {
	it('resolves once the file reports ACTIVE', async () => {
		withRequestUrl((param): MockRequestUrlResponse => {
			expect(param.method).toBe('GET');
			expect(param.url).toBe(`${BASE_URL}/v1beta/files/x`);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					name: 'files/x',
					uri: 'https://files.example/x',
					state: 'ACTIVE',
				}),
			};
		});

		await expect(
			waitUntilActive(BASE_URL, API_KEY, 'files/x'),
		).resolves.toBeUndefined();
	});

	it('throws when the file processing FAILED', async () => {
		withRequestUrl(() => statusResponse('FAILED'));

		await expect(
			waitUntilActive(BASE_URL, API_KEY, 'files/x'),
		).rejects.toThrow(/failed to process/i);
	});

	describe('a file Gemini is still working on', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('polls until the file turns ACTIVE', async () => {
			const sent = queueResponses([
				statusResponse('PROCESSING'),
				statusResponse('PROCESSING'),
				statusResponse('ACTIVE'),
			]);

			const pending = waitUntilActive(BASE_URL, API_KEY, 'files/x');
			await jest.advanceTimersByTimeAsync(
				GEMINI_FILE_POLL_INTERVAL_MS * 2,
			);

			await expect(pending).resolves.toBeUndefined();
			expect(sent).toHaveLength(3);
		});

		it('waits the poll interval between attempts rather than spinning', async () => {
			const sent = queueResponses([
				statusResponse('PROCESSING'),
				statusResponse('ACTIVE'),
			]);

			const pending = waitUntilActive(BASE_URL, API_KEY, 'files/x');
			await jest.advanceTimersByTimeAsync(
				GEMINI_FILE_POLL_INTERVAL_MS - 1,
			);

			expect(sent).toHaveLength(1);

			await jest.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toBeUndefined();
		});
	});

	it('gives up once the wait budget is spent', async () => {
		withRequestUrl(() => statusResponse('PROCESSING'));

		await expect(
			waitUntilActive(BASE_URL, API_KEY, 'files/x', 0),
		).rejects.toThrow(/timed out/i);
	});

	it.each([
		{ name: 'is not an object', body: 'nope' },
		{ name: 'names no file', body: {} },
		{ name: 'carries a name but no uri', body: { name: 'files/x' } },
	])('throws when the status response $name', async ({ body }) => {
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: JSON.stringify(body),
		}));

		await expect(
			waitUntilActive(BASE_URL, API_KEY, 'files/x'),
		).rejects.toThrow(/unexpected file response/i);
	});
});

describe('deleteFile', () => {
	it('issues a DELETE for the file resource', async () => {
		let seen: MockRequestUrlParam | undefined;
		withRequestUrl((param): MockRequestUrlResponse => {
			seen = param;
			return { status: 200, headers: {}, text: '' };
		});

		await deleteFile(BASE_URL, API_KEY, 'files/x');

		expect(seen?.method).toBe('DELETE');
		expect(seen?.url).toBe(`${BASE_URL}/v1beta/files/x`);
		expect(seen?.headers?.['x-goog-api-key']).toBe(API_KEY);
	});
});

// Gemini's key travels in a header of its own, and an empty one used to be
// sent as an empty string. A compatible local endpoint ignores it either way,
// but a header claiming an identity that does not exist is left off.
describe('the api-key header', () => {
	it('is absent from every request when no key is configured', async () => {
		const sent: MockRequestUrlParam[] = [];
		withRequestUrl((param): MockRequestUrlResponse => {
			sent.push(param);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({ name: 'files/x', uri: 'u' }),
			};
		});

		await deleteFile(BASE_URL, '', 'files/x');

		expect(at(sent, 0).headers).not.toHaveProperty('x-goog-api-key');
	});
});

describe('fileProcessingWaitMs', () => {
	it('uses the floor for a tiny file', () => {
		expect(fileProcessingWaitMs(0)).toBe(GEMINI_FILE_MIN_WAIT_MS);
		expect(fileProcessingWaitMs(1024)).toBeGreaterThanOrEqual(
			GEMINI_FILE_MIN_WAIT_MS,
		);
	});

	it('scales above the floor for a large file', () => {
		const wait = fileProcessingWaitMs(500 * 1024 * 1024);
		expect(wait).toBeGreaterThan(GEMINI_FILE_MIN_WAIT_MS);
		expect(wait).toBeLessThanOrEqual(GEMINI_FILE_MAX_WAIT_MS);
	});

	it('caps a very large file at the ceiling', () => {
		expect(fileProcessingWaitMs(8 * 1024 * 1024 * 1024)).toBe(
			GEMINI_FILE_MAX_WAIT_MS,
		);
	});
});
