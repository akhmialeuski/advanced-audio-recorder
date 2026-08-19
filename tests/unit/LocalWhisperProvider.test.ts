/** @jest-environment jsdom */
/**
 * The desktop-only whisper.cpp provider, and everything it does when the
 * binary does not behave.
 *
 * It shells out to a program the user chose the path of, so almost every
 * failure mode is one the user can hit by pointing it at the wrong file: a
 * binary that exits non-zero, one that writes no output, one that writes
 * something that is not JSON. Each has to say which of those happened, or the
 * only diagnosis left is "transcription failed".
 * @module tests/unit/LocalWhisperProvider.test
 */

import {
	LocalWhisperProvider,
	mapWhisperCppJson,
} from 'src/transcription/providers/LocalWhisperProvider';
import type {
	AudioPayload,
	TranscribeOptions,
} from 'src/transcription/providers/TranscriptionProvider';
import { at } from '../helpers/assertions';

interface RequireWindow {
	require?: (id: string) => unknown;
}

/** What the fake Node surface should do on this run. */
interface NodeBehaviour {
	/** Error handed to the execFile callback, when the binary fails. */
	execError?: Error;
	/** Output file contents, or a thrower for a binary that wrote none. */
	output?: string | (() => never);
	/** Makes window.require itself throw, as it does on mobile. */
	noRequire?: boolean;
}

/** Files the run removed on its way out. */
let removed: string[] = [];
/** Files the run wrote before invoking the binary. */
let written: string[] = [];

/** Installs a fake Node surface so the desktop-only provider can run. */
function installNode(behaviour: NodeBehaviour = {}): void {
	removed = [];
	written = [];
	if (behaviour.noRequire) {
		(window as RequireWindow).require = (): never => {
			throw new Error('require is not available here');
		};
		return;
	}
	const modules: Record<string, unknown> = {
		child_process: {
			execFile: (
				_file: string,
				_args: string[],
				_options: unknown,
				callback: (error: Error | null) => void,
			): void => {
				callback(behaviour.execError ?? null);
			},
		},
		fs: {
			writeFileSync: (path: string): void => {
				written.push(path);
			},
			readFileSync: (): string => {
				const output = behaviour.output;
				if (typeof output === 'function') {
					return output();
				}
				return (
					output ??
					JSON.stringify({
						language: 'en',
						transcription: [
							{ offsets: { from: 0, to: 1000 }, text: 'hi' },
						],
					})
				);
			},
			rmSync: (path: string): void => {
				removed.push(path);
			},
		},
		os: { tmpdir: (): string => '/tmp' },
		path: { join: (...parts: string[]): string => parts.join('/') },
	};
	(window as RequireWindow).require = (id: string): unknown => modules[id];
}

/** A provider over the fake Node surface. */
function createSut(): LocalWhisperProvider {
	return new LocalWhisperProvider({
		binaryPath: '/bin/whisper',
		modelPath: '/models/ggml.bin',
		extraArgs: [],
	});
}

/** The options a run carries; this provider reads none of them by default. */
function options(): TranscribeOptions {
	return { diarize: false, wordTimestamps: false };
}

/** A minimal audio payload; the provider only writes it to a temp file. */
function payload(): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: 'audio/wav',
		filename: 'rec.wav',
		offsetSeconds: 0,
	};
}

afterEach(() => {
	delete (window as RequireWindow).require;
});

describe('availability', () => {
	it('is available where Node can be reached', () => {
		installNode();

		expect(createSut().isAvailable()).toBe(true);
	});

	it('is unavailable where it cannot', () => {
		// On mobile there is no require at all, and the settings tab reads
		// this to grey the engine out rather than let a run start.
		installNode({ noRequire: true });

		expect(createSut().isAvailable()).toBe(false);
	});

	it('says why rather than failing obscurely when asked to run anyway', async () => {
		// A config synced from a desktop keeps this engine selected.
		installNode({ noRequire: true });

		await expect(
			createSut().transcribe(payload(), options()),
		).rejects.toThrow('only available in the desktop app');
	});
});

describe('running the binary', () => {
	it('returns the transcript it produced', async () => {
		installNode();

		const result = await createSut().transcribe(payload(), options());

		expect(result.language).toBe('en');
		expect(at(result.segments, 0)).toEqual({
			start: 0,
			end: 1,
			text: 'hi',
		});
	});

	it('reports a binary that exited with an error', async () => {
		installNode({ execError: new Error('model file not found') });

		await expect(
			createSut().transcribe(payload(), options()),
		).rejects.toThrow('model file not found');
	});

	it('says the binary wrote no output rather than that the audio was empty', async () => {
		installNode({
			output: (): never => {
				throw new Error('ENOENT');
			},
		});

		await expect(
			createSut().transcribe(payload(), options()),
		).rejects.toThrow('did not produce an output file');
	});

	it('says the output was not JSON rather than reporting a parse error', async () => {
		// A binary invoked without -oj writes plain text; the message has to
		// point at the flag, not at a JSON parser the user never called.
		installNode({ output: 'the quick brown fox' });

		await expect(
			createSut().transcribe(payload(), options()),
		).rejects.toThrow('invalid JSON output');
	});

	it.each([
		{ name: 'a successful run', behaviour: {} },
		{
			name: 'a binary that failed',
			behaviour: { execError: new Error('crashed') },
		},
		{
			name: 'output that would not parse',
			behaviour: { output: 'not json' },
		},
	])('removes both temporary files after $name', async ({ behaviour }) => {
		// The temp files are the audio and the transcript; leaving them
		// behind fills the system temp directory a recording at a time.
		installNode(behaviour);

		await createSut()
			.transcribe(payload(), options())
			.catch(() => undefined);

		expect(removed).toHaveLength(2);
	});
});

describe('reading whisper.cpp JSON', () => {
	it('converts millisecond offsets to seconds', () => {
		const result = mapWhisperCppJson({
			transcription: [{ offsets: { from: 1500, to: 4250 }, text: 'one' }],
		});

		expect(at(result.segments, 0)).toEqual({
			start: 1.5,
			end: 4.25,
			text: 'one',
		});
	});

	it('trims the text, which whisper.cpp pads with a leading space', () => {
		const result = mapWhisperCppJson({
			transcription: [{ offsets: { from: 0, to: 1 }, text: '  one  ' }],
		});

		expect(at(result.segments, 0).text).toBe('one');
	});

	it.each([
		{ name: 'a body that is not an object', body: 'not json at all' },
		{ name: 'a body with no transcription', body: {} },
		{
			name: 'a transcription that is not a list',
			body: { transcription: 'one' },
		},
		// The remaining shapes a crashed or half-written whisper.cpp run
		// leaves behind on disk.
		{ name: 'nothing at all', body: null },
		{ name: 'an empty string', body: '' },
		{ name: 'a bare list', body: [] },
		{ name: 'an empty transcription', body: { transcription: [] } },
	])('answers no segments for $name', ({ body }) => {
		expect(mapWhisperCppJson(body).segments).toEqual([]);
	});

	it.each([
		{ name: 'no offsets at all', entry: { text: 'one' } },
		{
			name: 'offsets that are not numbers',
			entry: { offsets: { from: 'a', to: 'b' }, text: 'one' },
		},
	])(
		'keeps the words of an entry with $name, timed at the start',
		({ entry }) => {
			// Spoken words are the thing being transcribed; dropping them because
			// whisper.cpp lost their offsets would lose content the user paid for.
			// Timing them at zero costs a wrong timestamp link, which is
			// recoverable by listening - the words are not.
			expect(
				mapWhisperCppJson({ transcription: [entry] }).segments,
			).toEqual([{ start: 0, end: 0, text: 'one' }]);
		},
	);

	it.each([
		{ name: 'an entry that is not an object', entry: 'one' },
		{
			name: 'an entry with no text',
			entry: { offsets: { from: 0, to: 1 } },
		},
		{
			name: 'an entry whose text is only whitespace',
			entry: { offsets: { from: 0, to: 1 }, text: '   ' },
		},
		{ name: 'an entry that is null', entry: null },
	])('skips $name', ({ entry }) => {
		// whisper.cpp emits blank segments for silence; each would become an
		// empty line in the transcript and an empty timestamp link.
		const result = mapWhisperCppJson({ transcription: [entry] });

		expect(result.segments).toEqual([]);
	});

	it('places an entry with no offsets at the start', () => {
		const result = mapWhisperCppJson({ transcription: [{ text: 'one' }] });

		expect(at(result.segments, 0)).toEqual({
			start: 0,
			end: 0,
			text: 'one',
		});
	});

	it('ends a segment where it began when only the start is readable', () => {
		const result = mapWhisperCppJson({
			transcription: [
				{ offsets: { from: 2000, to: 'later' }, text: 'one' },
			],
		});

		expect(at(result.segments, 0).end).toBe(2);
	});

	it('keeps the language even when there are no segments', () => {
		// The language decides how the transcript is post-processed, and an
		// empty recording still has one.
		const result = mapWhisperCppJson({
			language: 'ru',
			transcription: [],
		});

		expect(result.language).toBe('ru');
	});

	it('reports no language when the body names none', () => {
		const result = mapWhisperCppJson({ transcription: [] });

		expect(result.language).toBeUndefined();
	});
});
