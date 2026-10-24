/**
 * Opening a vault file as a mediabunny Input, for the readers that look at a
 * container's headers without decoding it: the file-info dialog, the metadata
 * probes, and the player's audio-or-video question.
 * @module audio/mediaInput
 */

import type { Input, Source, UrlSource } from 'mediabunny';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { disposableOf } from '../utils/disposables';
import { loadAudioEngine } from './audioEngine';

/**
 * A source reading a vault file through its resource URL, by range, so a
 * parse fetches the header and the index rather than the whole recording.
 *
 * It never retries. Mediabunny's default retries a rejected fetch with a
 * growing delay and gives up only when it suspects a cross-origin refusal,
 * which is right for a flaky network and wrong for a file served from the
 * device itself: where the vault is served from the page's own origin, as in
 * the mobile WebView, a request that failed once fails every time, and the
 * reader waiting on it - an open dialog, an embed still deciding which player
 * to show - waited forever. One failure is the answer, and every caller has a
 * fallback for it.
 *
 * A read that fails while nobody is waiting on it - a prefetch ahead of the
 * parse - is logged rather than left to become an unhandled rejection, which
 * is mediabunny's default: the read that needed those bytes fails on its own
 * and its caller falls back, so the stray one has nothing left to report.
 * @param url - Resource URL from app.vault.getResourcePath
 * @returns A source for an Input
 */
export async function resourceSource(url: string): Promise<UrlSource> {
	const { UrlSource } = await loadAudioEngine();
	return new UrlSource(url, {
		getRetryDelay: () => null,
		handleUnhandledError: (error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} A read ahead of ${url} failed:`,
				error,
			);
		},
	});
}

/**
 * Opens a container over a source and reads it, releasing the input however
 * the read ends.
 *
 * The read is awaited inside the scope that owns the input. A `using` binding
 * disposes at the end of its own scope, and an async function's scope ends the
 * moment it returns a promise rather than when that promise settles, so
 * handing the read back unawaited would dispose the input under a read that
 * has only just started. Mediabunny answers such a read with
 * InputDisposedError, which reads as a container it could not parse.
 * @param source - Where the bytes come from: a resource URL or memory
 * @param read - What to read from the opened container
 * @returns What the read returned
 */
export async function withMediaInput<T>(
	source: Source,
	read: (input: Input) => Promise<T>,
): Promise<T> {
	const { ALL_FORMATS, Input } = await loadAudioEngine();
	using input = disposableOf(new Input({ source, formats: ALL_FORMATS }));
	return await read(input);
}
