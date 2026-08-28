/** @jest-environment jsdom */
/**
 * Tests that LocalWhisperProvider injects the custom dictionary as the
 * whisper.cpp `--prompt` flag, joined with commas, places it before the user's
 * extra args so a manually supplied `--prompt` still overrides it, and omits
 * the flag entirely when no dictionary is set. The provider shells out through
 * Node, so the test installs a fake `window.require` that captures the
 * execFile argument vector.
 * @module tests/unit/LocalWhisperProviderDictionary.test
 */

import { LocalWhisperProvider } from 'src/transcription/providers/LocalWhisperProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';

interface RequireWindow {
	require?: (id: string) => unknown;
}

/** The args passed to execFile on the most recent run. */
let capturedArgs: string[] = [];

/** Installs a fake Node surface so the desktop-only provider can run. */
function installNodeMock(): void {
	const childProcess = {
		execFile: (
			_file: string,
			args: string[],
			_options: unknown,
			callback: (
				error: Error | null,
				stdout: string,
				stderr: string,
			) => void,
		): void => {
			capturedArgs = args;
			callback(null, '', '');
		},
	};
	const fs = {
		writeFileSync: (): void => undefined,
		// A minimal valid whisper.cpp JSON so mapWhisperCppJson returns a segment.
		readFileSync: (): string =>
			JSON.stringify({
				transcription: [{ offsets: { from: 0, to: 1000 }, text: 'hi' }],
			}),
		rmSync: (): void => undefined,
	};
	const modules: Record<string, unknown> = {
		child_process: childProcess,
		fs,
		os: { tmpdir: (): string => '/tmp' },
		path: { join: (...parts: string[]): string => parts.join('/') },
	};
	(window as RequireWindow).require = (id: string): unknown => modules[id];
}

function payload(): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: 'audio/wav',
		filename: 'rec.wav',
		offsetSeconds: 0,
	};
}

function provider(extraArgs: string[] = []): LocalWhisperProvider {
	return new LocalWhisperProvider({
		binaryPath: '/bin/whisper',
		modelPath: '/models/ggml.bin',
		extraArgs,
		processTimeoutMs: 60_000,
	});
}

/** The value following each `--prompt` occurrence, in order. */
function promptValues(): string[] {
	const values: string[] = [];
	capturedArgs.forEach((arg, index) => {
		if (arg === '--prompt') {
			const value = capturedArgs[index + 1];
			if (value !== undefined) {
				values.push(value);
			}
		}
	});
	return values;
}

beforeEach(() => {
	capturedArgs = [];
	installNodeMock();
});

afterEach(() => {
	delete (window as RequireWindow).require;
});

describe('LocalWhisperProvider dictionary biasing', () => {
	it('passes the dictionary as a comma-joined --prompt flag', async () => {
		await provider().transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		expect(promptValues()).toEqual(['Kubernetes, gRPC']);
	});

	it('omits the --prompt flag when no dictionary is set', async () => {
		await provider().transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(capturedArgs).not.toContain('--prompt');
	});

	it('places the injected --prompt before extraArgs so a user flag overrides it', async () => {
		await provider(['--prompt', 'user override']).transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes'],
		});

		// whisper.cpp is last-wins for repeated --prompt, so the injected value
		// must appear first and the user's value last.
		expect(promptValues()).toEqual(['Kubernetes', 'user override']);
	});
});
