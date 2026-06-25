/**
 * Tests for the Gemini File API helpers: the resumable upload (start then
 * finalize, including case-insensitive upload-URL header handling and the
 * default PROCESSING state), status polling that returns on ACTIVE and throws
 * on FAILED, and the best-effort delete. Obsidian's requestUrl is scripted
 * through the shared mock handler.
 */

import {
	deleteFile,
	uploadFile,
	waitUntilActive,
} from 'src/transcription/providers/geminiFileApi';
import { __setRequestUrlHandler, type MockRequestUrlParam } from 'obsidian';

const BASE_URL = 'https://gemini.example';
const API_KEY = 'gm-test';

afterEach(() => {
	__setRequestUrlHandler(null);
});

describe('uploadFile', () => {
	it('starts a resumable session then finalizes, returning the file', async () => {
		const calls: MockRequestUrlParam[] = [];
		__setRequestUrlHandler((param) => {
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
		expect(calls[0].url).toBe(`${BASE_URL}/upload/v1beta/files`);
		expect(calls[0].headers?.['X-Goog-Upload-Command']).toBe('start');
		expect(calls[1].url).toBe('https://upload.example/session');
		expect(calls[1].headers?.['X-Goog-Upload-Command']).toBe(
			'upload, finalize',
		);
	});

	it('reads the upload URL header case-insensitively and defaults a missing state', async () => {
		__setRequestUrlHandler((param) => {
			if (param.url.includes('/upload/')) {
				return {
					status: 200,
					headers: { 'x-goog-upload-url': 'https://up.example' },
					text: '',
				};
			}
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					file: { name: 'files/x', uri: 'https://files.example/x' },
				}),
			};
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
		__setRequestUrlHandler(() => ({
			status: 403,
			headers: {},
			text: 'forbidden',
		}));

		await expect(
			uploadFile(BASE_URL, API_KEY, new ArrayBuffer(1), 'audio/wav', 'a'),
		).rejects.toThrow(/authentication failed/i);
	});

	it('throws when the start step omits the upload URL header', async () => {
		__setRequestUrlHandler(() => ({ status: 200, headers: {}, text: '' }));

		await expect(
			uploadFile(BASE_URL, API_KEY, new ArrayBuffer(1), 'audio/wav', 'a'),
		).rejects.toThrow(/upload url/i);
	});
});

describe('waitUntilActive', () => {
	it('resolves once the file reports ACTIVE', async () => {
		__setRequestUrlHandler((param) => {
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
		__setRequestUrlHandler(() => ({
			status: 200,
			headers: {},
			text: JSON.stringify({
				name: 'files/x',
				uri: 'https://files.example/x',
				state: 'FAILED',
			}),
		}));

		await expect(
			waitUntilActive(BASE_URL, API_KEY, 'files/x'),
		).rejects.toThrow(/failed to process/i);
	});
});

describe('deleteFile', () => {
	it('issues a DELETE for the file resource', async () => {
		let seen: MockRequestUrlParam | undefined;
		__setRequestUrlHandler((param) => {
			seen = param;
			return { status: 200, headers: {}, text: '' };
		});

		await deleteFile(BASE_URL, API_KEY, 'files/x');

		expect(seen?.method).toBe('DELETE');
		expect(seen?.url).toBe(`${BASE_URL}/v1beta/files/x`);
		expect(seen?.headers?.['x-goog-api-key']).toBe(API_KEY);
	});
});
