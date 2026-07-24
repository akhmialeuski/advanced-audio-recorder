/**
 * Tests that every biasing engine routes the advanced two-pass context into
 * the request field its API supports: the generated bias sentence takes the
 * Whisper `prompt` (multipart) and whisper.cpp `--prompt` slots over the
 * plain dictionary join, Deepgram sends generated keyterms ahead of the
 * dictionary under the model's mechanism, and Gemini folds the sentence into
 * its instruction text. Outgoing requests are captured through the shared
 * requestUrl mock (and a fake Node surface for the local engine).
 * @module tests/unit/providerAdvancedBias.test
 */

import { WhisperApiProvider } from 'src/transcription/providers/WhisperApiProvider';
import { DeepgramProvider } from 'src/transcription/providers/DeepgramProvider';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { LocalWhisperProvider } from 'src/transcription/providers/LocalWhisperProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from 'obsidian';

const BIAS_SENTENCE =
	'Митинг про деплой и ревью, обсуждаются gRPC, CI/CD и Kubernetes.';

function payload(): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: 'audio/wav',
		filename: 'rec.wav',
		offsetSeconds: 0,
	};
}

afterEach(() => {
	__setRequestUrlHandler(null);
});

describe('WhisperApiProvider advanced bias', () => {
	/** Records every request and returns a minimal transcript. */
	function capture(): MockRequestUrlParam[] {
		const calls: MockRequestUrlParam[] = [];
		__setRequestUrlHandler((param): MockRequestUrlResponse => {
			calls.push(param);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({ text: 'hi' }),
			};
		});
		return calls;
	}

	it('sends the bias sentence as the prompt field, over the dictionary', async () => {
		const calls = capture();
		const provider = new WhisperApiProvider({
			baseUrl: 'https://whisper.example',
			apiKey: 'k',
			model: 'whisper-1',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
			biasPrompt: BIAS_SENTENCE,
		});

		const decoded = new TextDecoder().decode(calls[0].body as ArrayBuffer);
		expect(decoded).toContain('name="prompt"');
		expect(decoded).toContain(BIAS_SENTENCE);
		// The sentence replaces the comma-joined dictionary prompt; only one
		// prompt field may be sent.
		expect(decoded).not.toContain('Kubernetes, gRPC');
	});
});

describe('DeepgramProvider advanced bias', () => {
	/** Records every request and returns one valid utterance. */
	function capture(): MockRequestUrlParam[] {
		const calls: MockRequestUrlParam[] = [];
		__setRequestUrlHandler((param): MockRequestUrlResponse => {
			calls.push(param);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					results: {
						utterances: [{ transcript: 'hello', start: 0, end: 1 }],
					},
				}),
			};
		});
		return calls;
	}

	function provider(model: string): DeepgramProvider {
		return new DeepgramProvider({
			baseUrl: 'https://deepgram.example',
			apiKey: 'k',
			model,
		});
	}

	it('sends generated keyterms ahead of the dictionary on nova-3, deduplicated', async () => {
		const calls = capture();

		await provider('nova-3').transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Иванов', 'kubernetes'],
			keyterms: ['Kubernetes', 'CI/CD'],
		});

		const params = new URL(calls[0].url).searchParams;
		// Generated context first (it wins when limits trim), the dictionary
		// after it, and the case-insensitive duplicate sent only once.
		expect(params.getAll('keyterm')).toEqual([
			'Kubernetes',
			'CI/CD',
			'Иванов',
		]);
	});

	it('sends generated keyterms as keywords on nova-2', async () => {
		const calls = capture();

		await provider('nova-2').transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			keyterms: ['Kubernetes', 'CI/CD'],
		});

		const params = new URL(calls[0].url).searchParams;
		expect(params.getAll('keywords')).toEqual(['Kubernetes', 'CI/CD']);
		expect(params.getAll('keyterm')).toEqual([]);
	});
});

describe('GeminiProvider advanced bias', () => {
	/**
	 * Scripts the upload/poll/generate/delete flow and returns an accessor
	 * for the generateContent instruction text.
	 */
	function scriptFlow(): { instruction: () => string } {
		const calls: MockRequestUrlParam[] = [];
		const baseUrl = 'https://gemini.example';
		__setRequestUrlHandler((param): MockRequestUrlResponse => {
			calls.push(param);
			const url = param.url;
			if (url.endsWith('/upload/v1beta/files')) {
				return {
					status: 200,
					headers: { 'x-goog-upload-url': `${baseUrl}/session` },
					text: '',
				};
			}
			if (url === `${baseUrl}/session`) {
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
			}
			if (
				(param.method ?? 'GET') === 'GET' &&
				url === `${baseUrl}/v1beta/files/abc`
			) {
				return {
					status: 200,
					headers: {},
					text: JSON.stringify({
						name: 'files/abc',
						uri: 'https://files.example/abc',
						state: 'ACTIVE',
					}),
				};
			}
			if (url.includes(':generateContent')) {
				return {
					status: 200,
					headers: {},
					text: JSON.stringify({
						candidates: [
							{
								finishReason: 'STOP',
								content: {
									parts: [
										{
											text: JSON.stringify({
												segments: [],
											}),
										},
									],
								},
							},
						],
					}),
				};
			}
			return { status: 200, headers: {}, text: '' };
		});
		return {
			instruction: (): string => {
				const gen = calls.find((call) =>
					call.url.includes(':generateContent'),
				);
				const body = JSON.parse(String(gen?.body)) as {
					contents: { parts: { text?: string }[] }[];
				};
				return body.contents[0].parts
					.map((part) => part.text ?? '')
					.join(' ');
			},
		};
	}

	it('folds the bias sentence into the instruction text', async () => {
		const flow = scriptFlow();
		const provider = new GeminiProvider({
			baseUrl: 'https://gemini.example',
			apiKey: 'k',
			model: 'gemini-2.5-flash',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			biasPrompt: BIAS_SENTENCE,
		});

		const instruction = flow.instruction();
		expect(instruction).toContain('Context about this recording');
		expect(instruction).toContain(BIAS_SENTENCE);
	});
});

describe('LocalWhisperProvider advanced bias', () => {
	interface RequireWindow {
		require?: (id: string) => unknown;
	}
	let capturedArgs: string[] = [];

	beforeEach(() => {
		capturedArgs = [];
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
		const modules: Record<string, unknown> = {
			child_process: childProcess,
			fs: {
				writeFileSync: (): void => undefined,
				readFileSync: (): string =>
					JSON.stringify({
						transcription: [
							{ offsets: { from: 0, to: 1000 }, text: 'hi' },
						],
					}),
				rmSync: (): void => undefined,
			},
			os: { tmpdir: (): string => '/tmp' },
			path: { join: (...parts: string[]): string => parts.join('/') },
		};
		(window as RequireWindow).require = (id: string): unknown =>
			modules[id];
	});

	afterEach(() => {
		delete (window as RequireWindow).require;
	});

	it('passes the bias sentence as --prompt, over the dictionary join', async () => {
		const provider = new LocalWhisperProvider({
			binaryPath: '/bin/whisper',
			modelPath: '/models/ggml.bin',
			extraArgs: [],
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
			biasPrompt: BIAS_SENTENCE,
		});

		const promptIndex = capturedArgs.indexOf('--prompt');
		expect(promptIndex).toBeGreaterThanOrEqual(0);
		expect(capturedArgs[promptIndex + 1]).toBe(BIAS_SENTENCE);
		expect(capturedArgs).not.toContain('Kubernetes, gRPC');
	});
});
