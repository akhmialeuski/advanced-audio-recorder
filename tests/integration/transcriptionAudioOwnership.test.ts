/**
 * A run sends the same audio more than once - again after a refusal it may get
 * past, and again for the advanced second pass - so nothing on the way to the
 * engine may use the bytes up.
 *
 * Issue #136 is what happened when something did. A WebM recording sent to
 * Gemini was decoded to WAV inside the provider, from the very buffer the run
 * held, and Chromium's decoder takes the buffer it is given. The first attempt
 * then met a temporary refusal, the retry handed the provider the same, now
 * empty, buffer, and the run failed with "Cannot decode detached ArrayBuffer"
 * instead of the 503 that started it. Every suite stubbed the decode with one
 * that left its input intact, so none of them could see it.
 *
 * These run the real pipeline - preparation, chunk encoding, the service and
 * the shipping providers - and replace only the two boundaries: the network,
 * and a Web Audio decoder that takes its input the way the browser's does.
 * @module tests/integration/transcriptionAudioOwnership.test
 */

import type { App, TFile } from 'obsidian';
import {
	TranscriptionService,
	type TranscribeRunResult,
} from 'src/transcription/TranscriptionService';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { VoxtralProvider } from 'src/transcription/providers/VoxtralProvider';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettingsInput } from 'src/settings/settingsSchema';
import { TRANSCRIBE_RETRY_MAX_DELAY_MS, WAV_MIME } from 'src/constants';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { settleAcross } from '../helpers/async';
import { contextAgentsLlm } from '../helpers/llmDoubles';
import { withRequestUrl } from '../helpers/network';
import {
	installTransferringDecoder,
	type TransferringDecoder,
} from '../helpers/webAudioDecode';
import type {
	MockRequestUrlParam,
	MockRequestUrlResponse,
} from '../mocks/obsidian';

/** The size of the recording in the report, byte for byte. */
const RECORDING_BYTES = 36_079;

/** How long the recording plays, inside every engine's per-request limit. */
const RECORDING_SECONDS = 6;

const GEMINI_URL = 'https://gemini.example';
const VOXTRAL_URL = 'https://mistral.example/v1';
const UPLOAD_SESSION_URL = `${GEMINI_URL}/upload-session`;

/** The refusal the report's first attempt is taken to have met. */
const OVERLOADED: MockRequestUrlResponse = {
	status: 503,
	headers: {},
	text: JSON.stringify({
		error: { code: 503, message: 'The model is overloaded.' },
	}),
};

let decoder: TransferringDecoder;

beforeEach(() => {
	jest.useFakeTimers();
	decoder = installTransferringDecoder(RECORDING_SECONDS);
	// Every refusal the run waits out is logged; the one case about the log
	// reads it back from this spy.
	jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	decoder.restore();
	jest.useRealTimers();
});

/**
 * A recording of the given container, as the vault hands it out.
 * @param extension - The container, as the file's extension
 * @returns The file and the bytes a read of it returns
 */
function recording(extension: string): { file: TFile; bytes: ArrayBuffer } {
	const name = `2026-10-22-174847.${extension}`;
	return {
		file: partial<TFile>({ name, extension, path: name }),
		bytes: new Uint8Array(RECORDING_BYTES).fill(0x1a).buffer,
	};
}

/** What one scripted endpoint was sent. */
interface EndpointLog {
	/** Every audio body uploaded, in order, as the bytes it carried. */
	readonly uploads: Uint8Array[];
	/** The content type each audio upload declared, in the same order. */
	readonly uploadTypes: string[];
}

/** A transcript answer in Gemini's structured-output envelope. */
function geminiAnswer(text: string): string {
	return JSON.stringify({
		candidates: [
			{
				finishReason: 'STOP',
				content: {
					parts: [
						{
							text: JSON.stringify({
								language: 'ru',
								segments: [
									{ start: 0, end: RECORDING_SECONDS, text },
								],
							}),
						},
					],
				},
			},
		],
	});
}

/**
 * The audio a generate request carries inline, or null when it references an
 * uploaded file instead.
 * @param body - The request body
 */
function inlineAudioOf(
	body: unknown,
): { mimeType: string; bytes: Uint8Array } | null {
	if (typeof body !== 'string') {
		return null;
	}
	const parsed = JSON.parse(body) as {
		contents: {
			parts: { inlineData?: { mimeType: string; data: string } }[];
		}[];
	};
	const inline = parsed.contents[0]?.parts[0]?.inlineData;
	return inline
		? {
				mimeType: inline.mimeType,
				bytes: new Uint8Array(Buffer.from(inline.data, 'base64')),
			}
		: null;
}

/**
 * Scripts the Gemini File API and generateContent. Audio reaches Gemini either
 * uploaded through a File API session or inline in the generate request, and
 * the log records it from whichever of the two carried it.
 * @param options.refusals - How many generate calls are refused before one is answered
 * @param options.answer - The transcript text for a generate call, given its body
 * @returns What the endpoint was sent
 */
function scriptGemini(options: {
	refusals: number;
	answer: (generateBody: string) => string;
}): EndpointLog {
	const log: EndpointLog = { uploads: [], uploadTypes: [] };
	let refusalsLeft = options.refusals;
	const file = {
		name: 'files/a',
		uri: 'https://files.example/a',
		state: 'ACTIVE',
	};
	withRequestUrl((param: MockRequestUrlParam): MockRequestUrlResponse => {
		if (param.url.endsWith('/upload/v1beta/files')) {
			log.uploadTypes.push(
				param.headers?.['X-Goog-Upload-Header-Content-Type'] ?? '',
			);
			return {
				status: 200,
				headers: { 'x-goog-upload-url': UPLOAD_SESSION_URL },
				text: '',
			};
		}
		if (param.url === UPLOAD_SESSION_URL) {
			log.uploads.push(new Uint8Array(param.body as ArrayBuffer).slice());
			return { status: 200, headers: {}, text: JSON.stringify({ file }) };
		}
		if (param.url.includes(':generateContent')) {
			const inline = inlineAudioOf(param.body);
			if (inline) {
				log.uploadTypes.push(inline.mimeType);
				log.uploads.push(inline.bytes);
			}
			if (refusalsLeft > 0) {
				refusalsLeft--;
				return OVERLOADED;
			}
			// generateContent is a JSON request, so its body is text.
			const body = typeof param.body === 'string' ? param.body : '';
			return {
				status: 200,
				headers: {},
				text: geminiAnswer(options.answer(body)),
			};
		}
		// The status poll and the best-effort delete.
		return { status: 200, headers: {}, text: JSON.stringify(file) };
	});
	return log;
}

/**
 * Scripts Voxtral's transcription endpoint, recording the multipart bodies.
 * @param refusals - How many requests are refused before one is answered
 * @returns What the endpoint was sent
 */
function scriptVoxtral(refusals: number): EndpointLog {
	const log: EndpointLog = { uploads: [], uploadTypes: [] };
	let refusalsLeft = refusals;
	withRequestUrl((param: MockRequestUrlParam): MockRequestUrlResponse => {
		const body = new Uint8Array(param.body as ArrayBuffer).slice();
		log.uploads.push(body);
		const type = /Content-Type: (audio\/[\w-]+)/.exec(
			new TextDecoder().decode(body),
		);
		log.uploadTypes.push(type?.[1] ?? '');
		if (refusalsLeft > 0) {
			refusalsLeft--;
			return OVERLOADED;
		}
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({
				text: 'recovered',
				language: 'pl',
				segments: [
					{ start: 0, end: RECORDING_SECONDS, text: 'recovered' },
				],
			}),
		};
	});
	return log;
}

function gemini(): GeminiProvider {
	return new GeminiProvider({
		baseUrl: GEMINI_URL,
		apiKey: 'gm-test',
		model: 'gemini-3.5-flash',
	});
}

function voxtral(): VoxtralProvider {
	return new VoxtralProvider({
		baseUrl: VOXTRAL_URL,
		apiKey: 'mi-test',
		model: 'voxtral-mini-latest',
	});
}

/**
 * Runs one transcription of a recording to completion, letting every retry
 * pause elapse on the fake clock.
 * @param provider - The engine the run goes through
 * @param bytes - What the vault read of the recording returns
 * @param file - The recording
 * @param settings - The settings this case changes
 * @returns What the run produced, or the error it ended with
 */
async function runToCompletion(
	provider: TranscriptionProvider,
	{ file, bytes }: { file: TFile; bytes: ArrayBuffer },
	settings: AudioRecorderSettingsInput = {},
): Promise<TranscribeRunResult> {
	const app: App = createMockApp({
		vault: { readBinary: jest.fn(async () => bytes) },
		fileManager: { generateMarkdownLink: jest.fn(() => '[[rec]]') },
	}).app;
	const service = new TranscriptionService(
		app,
		() =>
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider.id,
				...settings,
			}),
		{
			createProvider: () => provider,
			createLlm: () => contextAgentsLlm().llm,
		},
	);
	return settleAcross(
		service.run(file, { notePathForLinks: 'note.md' }),
		TRANSCRIBE_RETRY_MAX_DELAY_MS * 4,
	);
}

describe('a WebM recording an engine refused for now', () => {
	it('is transcribed by Gemini on the attempt after the refusal', async () => {
		scriptGemini({ refusals: 1, answer: () => 'recovered' });

		const result = await runToCompletion(gemini(), recording('webm'));

		expect(result.markdown).toContain('recovered');
	});

	it('is decoded once for Gemini however many times it is sent', async () => {
		scriptGemini({ refusals: 1, answer: () => 'recovered' });

		await runToCompletion(gemini(), recording('webm'));

		expect(decoder.decodedByteLengths).toEqual([RECORDING_BYTES]);
	});

	it('reaches Gemini as the same WAV on every attempt', async () => {
		const log = scriptGemini({ refusals: 1, answer: () => 'recovered' });

		await runToCompletion(gemini(), recording('webm'));

		expect(log.uploadTypes).toEqual([WAV_MIME, WAV_MIME]);
		expect(log.uploads[0]?.byteLength).toBeGreaterThan(0);
		expect(log.uploads[1]).toEqual(log.uploads[0]);
	});

	it('is transcribed by Voxtral on the attempt after the refusal', async () => {
		const log = scriptVoxtral(1);

		const result = await runToCompletion(voxtral(), recording('webm'));

		expect(result.markdown).toContain('recovered');
		expect(log.uploadTypes).toEqual([WAV_MIME, WAV_MIME]);
		expect(decoder.decodedByteLengths).toEqual([RECORDING_BYTES]);
	});
});

describe('a recording in a container the engine reads as it stands', () => {
	it('is sent to Gemini again without ever being decoded', async () => {
		const log = scriptGemini({ refusals: 1, answer: () => 'recovered' });

		const result = await runToCompletion(gemini(), recording('ogg'));

		expect(result.markdown).toContain('recovered');
		expect(decoder.decodedByteLengths).toEqual([]);
		expect(log.uploads.map((upload) => upload.byteLength)).toEqual([
			RECORDING_BYTES,
			RECORDING_BYTES,
		]);
	});
});

describe('the advanced second pass over a WebM recording', () => {
	it('sends Gemini the audio the first pass sent and adopts its transcript', async () => {
		const log = scriptGemini({
			refusals: 0,
			answer: (body) =>
				body.includes('Kubernetes')
					? 'Поручим Иванову деплой сервиса в Kubernetes.'
					: 'Поручим Иванову деплой сервиса в кубернетис.',
		});

		const result = await runToCompletion(gemini(), recording('webm'), {
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		});

		expect(result.markdown).toContain('Kubernetes');
		expect(log.uploads).toHaveLength(2);
		expect(log.uploads[1]).toEqual(log.uploads[0]);
		expect(decoder.decodedByteLengths).toEqual([RECORDING_BYTES]);
	});
});

describe('a part whose audio something used up', () => {
	// Preparation never lets this happen on the shipping path; the guard is
	// for the next provider that decodes what it was lent. Without it the
	// retry uploaded nothing, or failed naming the decoder rather than the
	// defect.
	it('is refused by name rather than sent again', async () => {
		scriptGemini({ refusals: 1, answer: () => 'recovered' });
		const shipping = gemini();
		const consuming: TranscriptionProvider = {
			id: shipping.id,
			label: shipping.label,
			requiresNetwork: shipping.requiresNetwork,
			capabilities: shipping.capabilities,
			// Sends what it was lent, then takes it, as a provider decoding
			// its payload would: the first attempt is whole, and only a send
			// after it finds the bytes gone.
			transcribe: async (payload, options) => {
				try {
					return await shipping.transcribe(payload, options);
				} finally {
					(
						payload.data as ArrayBuffer & {
							transfer(): ArrayBuffer;
						}
					).transfer();
				}
			},
		};

		const run = runToCompletion(consuming, recording('ogg'));

		await expect(run).rejects.toThrow(
			'The audio for the recording was used up before it could be sent.',
		);
	});
});

describe('a refusal the run waits out', () => {
	// The run ends with the last attempt's error, so a different failure on
	// the retry would otherwise leave the refusal that started it unrecorded.
	it('is written to the console with the attempt it ended', async () => {
		scriptGemini({ refusals: 1, answer: () => 'recovered' });

		await runToCompletion(gemini(), recording('webm'));

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('The audio was refused on attempt 1'),
			expect.objectContaining({ status: 503 }),
		);
	});
});
