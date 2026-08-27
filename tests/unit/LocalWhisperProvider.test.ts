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
import {
	installNodeSurface,
	type NodeSurface,
	type NodeSurfaceBehaviour,
} from '../helpers/nodeSurface';

/** The fake Node surface of the current test, installed by installNode. */
// Null until a test installs one: the JSON-mapping tests below need no Node
// surface at all, and in a random order one of them can run first.
let node: NodeSurface | null = null;

/** Installs a fake Node surface so the desktop-only provider can run. */
function installNode(behaviour: NodeSurfaceBehaviour = {}): NodeSurface {
	node = installNodeSurface(behaviour);
	return node;
}

/** A provider over the fake Node surface. */
function createSut(): LocalWhisperProvider {
	return new LocalWhisperProvider({
		binaryPath: '/bin/whisper',
		modelPath: '/models/ggml.bin',
		extraArgs: [],
		processTimeoutMs: 60_000,
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
	node?.restore();
	node = null;
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
			writesNoOutput: true,
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
		const surface = installNode(behaviour);

		await createSut()
			.transcribe(payload(), options())
			.catch(() => undefined);

		expect(surface.removed).toHaveLength(2);
	});
});

// A binary the plugin only knows by the path a user typed can hang, and until
// it was bounded nothing could end it: the promise stayed pending, the dialog
// stayed busy until Obsidian restarted, and the process kept the CPU. Cancel
// did nothing either, because the run's token is read between parts and this
// engine has one part.
describe('a run that does not come back', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	/** The temp files a run leaves behind, whichever way it ended. */
	function removedFiles(): string[] {
		return node?.removed ?? [];
	}

	it('asks Node to stop the process at the configured limit', async () => {
		installNode();

		await createSut().transcribe(payload(), options());

		expect(node?.lastOptions()?.timeout).toBe(60_000);
	});

	it('hands the run cancel to the process it starts', async () => {
		installNode();
		const signal = new AbortController().signal;

		await createSut().transcribe(payload(), { ...options(), signal });

		expect(node?.lastOptions()?.signal).toBe(signal);
	});

	it('fails a run that outlives its limit, naming the setting that raises it', async () => {
		jest.useFakeTimers();
		installNode({ neverSettles: true });

		const settled = createSut()
			.transcribe(payload(), options())
			.catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(60_000);

		expect(await settled).toHaveProperty(
			'message',
			expect.stringContaining('Local run timeout'),
		);
	});

	it('removes both temp files when the run is stopped at its limit', async () => {
		jest.useFakeTimers();
		installNode({ neverSettles: true });

		const settled = createSut()
			.transcribe(payload(), options())
			.catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(60_000);
		await settled;

		expect(removedFiles()).toEqual([
			expect.stringMatching(/\.wav$/),
			expect.stringMatching(/\.json$/),
		]);
	});

	it('reports a cancelled run as cancelled rather than as a failed binary', async () => {
		installNode({ neverSettles: true });
		const controller = new AbortController();

		const settled = createSut()
			.transcribe(payload(), { ...options(), signal: controller.signal })
			.catch((error: unknown) => error);
		controller.abort();

		expect(await settled).toHaveProperty(
			'message',
			'Local whisper.cpp run was cancelled.',
		);
	});

	it('removes both temp files when the run is cancelled', async () => {
		installNode({ neverSettles: true });
		const controller = new AbortController();

		const settled = createSut()
			.transcribe(payload(), { ...options(), signal: controller.signal })
			.catch((error: unknown) => error);
		controller.abort();
		await settled;

		expect(removedFiles()).toEqual([
			expect.stringMatching(/\.wav$/),
			expect.stringMatching(/\.json$/),
		]);
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
