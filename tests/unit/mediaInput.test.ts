/**
 * Unit tests for the shared mediabunny opener the header readers use.
 * @module tests/unit/mediaInput.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { resourceSource, withMediaInput } from 'src/audio/mediaInput';
import {
	firstUrlSourceOptions,
	inputDispose,
} from '../mocks/modules/mediabunny';

describe('resourceSource', () => {
	it('reads the resource URL it was given', async () => {
		const { UrlSource } = jest.requireMock<{ UrlSource: jest.Mock }>(
			'mediabunny',
		);

		await resourceSource('app://vault/a.webm');

		expect(UrlSource).toHaveBeenCalledWith(
			'app://vault/a.webm',
			firstUrlSourceOptions(),
		);
	});

	it.each([1, 2, 10])(
		'never retries, even after %i attempts',
		async (attempts) => {
			await resourceSource('app://vault/a.webm');

			expect(
				firstUrlSourceOptions().getRetryDelay?.(attempts),
			).toBeNull();
		},
	);

	it('logs a failed read nobody was waiting on instead of throwing it', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		await resourceSource('app://vault/a.webm');
		const error = new Error('connection reset');

		firstUrlSourceOptions().handleUnhandledError?.(error);

		expect(warn).toHaveBeenCalledWith(
			'[AudioRecorder] A read ahead of app://vault/a.webm failed:',
			error,
		);
	});
});

describe('withMediaInput', () => {
	it('answers with what the read returned', async () => {
		const answer = await withMediaInput(
			await resourceSource('app://vault/a.webm'),
			() => Promise.resolve(42),
		);

		expect(answer).toBe(42);
	});

	it('releases the input when the read fails', async () => {
		const source = await resourceSource('app://vault/a.webm');

		await expect(
			withMediaInput(source, () =>
				Promise.reject(new Error('unparseable')),
			),
		).rejects.toThrow('unparseable');

		expect(inputDispose).toHaveBeenCalledTimes(1);
	});
});
