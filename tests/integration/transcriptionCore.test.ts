/**
 * Tests for the smaller pure transcription helpers: chunk planning,
 * Whisper/LLM response mapping, prompt building, file paths, and
 * provider-factory validation.
 */

import { planChunks } from 'src/transcription/audioChunks';
import { at, defined } from '../helpers/assertions';
import { mapWhisperResponse } from 'src/transcription/providers/whisperResponse';
import { mapWhisperCppJson } from 'src/transcription/providers/LocalWhisperProvider';
import {
	extractAnthropicText,
	extractOpenAiText,
} from 'src/transcription/llm/llmResponse';
import { buildPostProcessPrompt } from 'src/transcription/llmPostProcess';
import { buildTranscriptFilePath } from 'src/transcription/transcriptOutput';
import {
	createLlmProvider,
	createTranscriptionProvider,
	parseArgs,
	ProviderConfigError,
} from 'src/transcription/factories';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	TRANSCRIBE_BYTES_PER_SEC,
	DEFAULT_LLM_CLEANUP_PROMPT,
	DEFAULT_LLM_SUMMARY_PROMPT,
} from 'src/constants';
import { WAV_HEADER_SIZE } from 'src/audio/WavEncoder';

describe('planChunks', () => {
	it('returns nothing for non-positive duration', () => {
		expect(planChunks(0, 1_000_000)).toEqual([]);
		expect(planChunks(Number.NaN, 1_000_000)).toEqual([]);
	});

	it('returns one chunk when the file fits', () => {
		const plans = planChunks(60, 100 * TRANSCRIBE_BYTES_PER_SEC);
		expect(plans).toEqual([{ index: 0, startSeconds: 0, endSeconds: 60 }]);
	});

	it('splits into chunks bounded by the byte budget (leaving room for the WAV header)', () => {
		// 10s of PCM plus the 44-byte WAV header exceeds the budget, so the
		// per-chunk budget is 9s: 25s total -> 3 chunks (9, 9, 7).
		const plans = planChunks(25, 10 * TRANSCRIBE_BYTES_PER_SEC);
		expect(plans).toEqual([
			{ index: 0, startSeconds: 0, endSeconds: 9 },
			{ index: 1, startSeconds: 9, endSeconds: 18 },
			{ index: 2, startSeconds: 18, endSeconds: 25 },
		]);
	});

	it('keeps every chunk within the byte limit once the WAV header is added', () => {
		const maxBytes = 10 * TRANSCRIBE_BYTES_PER_SEC;
		const plans = planChunks(25, maxBytes);
		for (const plan of plans) {
			const pcmBytes =
				(plan.endSeconds - plan.startSeconds) *
				TRANSCRIBE_BYTES_PER_SEC;
			expect(pcmBytes + WAV_HEADER_SIZE).toBeLessThanOrEqual(maxBytes);
		}
	});
});

describe('mapWhisperResponse', () => {
	it('maps verbose_json segments with speaker and words', () => {
		const result = mapWhisperResponse({
			language: 'en',
			segments: [
				{
					start: 0,
					end: 1.5,
					text: ' Hello ',
					speaker: 'SPEAKER_00',
					words: [{ word: 'Hello', start: 0, end: 1 }],
				},
				{ start: 1.5, end: 2, text: '' },
			],
		});
		expect(result.language).toBe('en');
		expect(result.segments).toHaveLength(1);
		expect(at(result.segments, 0).text).toBe('Hello');
		expect(at(result.segments, 0).speaker).toBe('SPEAKER_00');
		expect(at(defined(at(result.segments, 0).words), 0).text).toBe('Hello');
	});

	it('falls back to the flat text when no segments are present', () => {
		const result = mapWhisperResponse({ text: 'just text' });
		expect(result.segments).toEqual([
			{ start: 0, end: 0, text: 'just text' },
		]);
	});

	it('tolerates malformed bodies', () => {
		expect(mapWhisperResponse(null).segments).toEqual([]);
		expect(mapWhisperResponse('nope').segments).toEqual([]);
	});
});

describe('mapWhisperCppJson', () => {
	it('maps transcription items with millisecond offsets to seconds', () => {
		const result = mapWhisperCppJson({
			transcription: [
				{ offsets: { from: 0, to: 1500 }, text: ' Hi ' },
				{ offsets: { from: 1500, to: 3000 }, text: '' },
			],
		});
		expect(result.segments).toEqual([{ start: 0, end: 1.5, text: 'Hi' }]);
	});
});

describe('LLM response extractors', () => {
	// A provider that changes its envelope, an error body returned with a 200,
	// or a truncated response all arrive here as something other than the
	// happy shape. Every one of them must read as "no text", never as a crash
	// in the middle of a paid run.
	it.each([
		{
			name: 'a chat completion',
			body: { choices: [{ message: { content: ' hi ' } }] },
			expected: 'hi',
		},
		{ name: 'no choices at all', body: { choices: [] }, expected: '' },
		{
			name: 'choices that are not an array',
			body: { choices: {} },
			expected: '',
		},
		{
			name: 'a choice with no message',
			body: { choices: [{}] },
			expected: '',
		},
		{
			name: 'a message with no content',
			body: { choices: [{ message: {} }] },
			expected: '',
		},
		{
			name: 'content that is not a string',
			body: { choices: [{ message: { content: 42 } }] },
			expected: '',
		},
		{ name: 'a body that is not an object', body: 'oops', expected: '' },
		{ name: 'a null body', body: null, expected: '' },
	])('reads $name as "$expected" (OpenAI)', ({ body, expected }) => {
		expect(extractOpenAiText(body)).toBe(expected);
	});

	it.each([
		{
			name: 'text blocks, joined',
			body: {
				content: [
					{ type: 'text', text: 'a' },
					{ type: 'thinking', text: 'ignored' },
					{ type: 'text', text: 'b' },
				],
			},
			expected: 'ab',
		},
		{
			name: 'a single block with surrounding space',
			body: { content: [{ type: 'text', text: '  hi  ' }] },
			expected: 'hi',
		},
		{ name: 'an empty content array', body: { content: [] }, expected: '' },
		{
			name: 'content that is not an array',
			body: { content: 'hi' },
			expected: '',
		},
		{
			name: 'a block that is not an object',
			body: { content: ['hi'] },
			expected: '',
		},
		{
			name: 'a text block whose text is not a string',
			body: { content: [{ type: 'text', text: 42 }] },
			expected: '',
		},
		{ name: 'a body that is not an object', body: 7, expected: '' },
	])('reads $name as "$expected" (Anthropic)', ({ body, expected }) => {
		expect(extractAnthropicText(body)).toBe(expected);
	});
});

describe('buildPostProcessPrompt', () => {
	it('builds a cleanup prompt that preserves content and language', () => {
		const prompt = buildPostProcessPrompt('raw text', {
			task: 'cleanup',
			language: 'ru',
		});
		expect(prompt.user).toBe('raw text');
		expect(prompt.system.toLowerCase()).toContain('punctuation');
		expect(prompt.system).toContain('ru');
	});

	it('uses the custom instruction for the custom task', () => {
		const prompt = buildPostProcessPrompt('x', {
			task: 'custom',
			customInstruction: 'Bullet it',
		});
		expect(prompt.system).toBe('Bullet it');
	});

	it('appends the glossary spellings to the cleanup prompt only', () => {
		const cleanup = buildPostProcessPrompt('t', {
			task: 'cleanup',
			glossary: ['Kubernetes', 'CI/CD'],
		});
		expect(cleanup.system).toContain('Kubernetes, CI/CD');
		// A summary rewords anyway, so the glossary clause stays out of it.
		const summary = buildPostProcessPrompt('t', {
			task: 'summary',
			glossary: ['Kubernetes'],
		});
		expect(summary.system).not.toContain('Kubernetes');
	});

	it('omits the glossary clause when no terms are configured', () => {
		const prompt = buildPostProcessPrompt('t', { task: 'cleanup' });
		expect(prompt.system).not.toContain('canonical spelling');
	});

	it('uses the provided cleanup template and appends the language', () => {
		const prompt = buildPostProcessPrompt('t', {
			task: 'cleanup',
			language: 'es',
			cleanupPrompt: 'MY CLEANUP BASE',
		});
		expect(prompt.system).toContain('MY CLEANUP BASE');
		expect(prompt.system).toContain('es');
	});

	it('uses the provided summary template', () => {
		const prompt = buildPostProcessPrompt('t', {
			task: 'summary',
			summaryPrompt: 'MY SUMMARY BASE',
		});
		expect(prompt.system).toContain('MY SUMMARY BASE');
	});

	it('falls back to the shipped default when a template is empty', () => {
		// Clearing the field in settings leaves an empty string; the request must
		// still carry a usable system prompt rather than sending none.
		const cleanup = buildPostProcessPrompt('t', {
			task: 'cleanup',
			cleanupPrompt: '',
		});
		expect(cleanup.system).toContain(DEFAULT_LLM_CLEANUP_PROMPT);
		const summary = buildPostProcessPrompt('t', {
			task: 'summary',
			summaryPrompt: '   ',
		});
		expect(summary.system).toContain(DEFAULT_LLM_SUMMARY_PROMPT);
	});

	// The engine may not report a language (a whole-file run with detection
	// off), and a summary written in the wrong language is unusable.
	it('asks for the summary in the transcript language when none was detected', () => {
		const prompt = buildPostProcessPrompt('t', { task: 'summary' });

		expect(prompt.system).toContain(
			'in the same language as the transcript',
		);
	});

	it('names the detected language in the summary instruction', () => {
		const prompt = buildPostProcessPrompt('t', {
			task: 'summary',
			language: 'de',
		});

		expect(prompt.system).toContain('Write the summary in de.');
	});

	it.each([
		{ name: 'was cleared', customInstruction: '' },
		{ name: 'is only whitespace', customInstruction: '   ' },
	])(
		'falls back to a usable instruction when the custom one $name',
		({ customInstruction }) => {
			const prompt = buildPostProcessPrompt('t', {
				task: 'custom',
				customInstruction,
			});

			expect(prompt.system).toBe(
				'Process the following transcript as instructed.',
			);
		},
	);

	it('falls back to a usable instruction when none was ever set', () => {
		const prompt = buildPostProcessPrompt('t', { task: 'custom' });

		expect(prompt.system).toBe(
			'Process the following transcript as instructed.',
		);
	});
});

describe('buildTranscriptFilePath', () => {
	it('uses a .transcript.json suffix for JSON', () => {
		expect(buildTranscriptFilePath('audio/rec.webm', 'json')).toBe(
			'audio/rec.transcript.json',
		);
	});
	it('uses the conventional extension for subtitle formats', () => {
		expect(buildTranscriptFilePath('audio/rec.webm', 'srt')).toBe(
			'audio/rec.srt',
		);
		expect(buildTranscriptFilePath('rec.mp3', 'vtt')).toBe('rec.vtt');
	});
});

describe('parseArgs', () => {
	it('splits on whitespace and drops empties', () => {
		expect(parseArgs('  -t 4   -l en ')).toEqual(['-t', '4', '-l', 'en']);
		expect(parseArgs('')).toEqual([]);
	});
});

describe('provider factories', () => {
	it('requires a Whisper API key', () => {
		const settings = mergeSettings({
			transcriptionProvider: 'whisper-api',
			whisperApiKey: '',
		});
		expect(() => createTranscriptionProvider(settings)).toThrow(
			ProviderConfigError,
		);
	});

	it('requires local whisper paths', () => {
		const settings = mergeSettings({
			transcriptionProvider: 'local-whisper',
			localWhisperBinaryPath: '',
			localWhisperModelPath: '',
		});
		expect(() => createTranscriptionProvider(settings)).toThrow(
			ProviderConfigError,
		);
	});

	it('requires a Deepgram API key', () => {
		const settings = mergeSettings({
			transcriptionProvider: 'deepgram',
			deepgramApiKey: '',
		});
		expect(() => createTranscriptionProvider(settings)).toThrow(
			ProviderConfigError,
		);
	});

	it('builds a whole-file Deepgram provider with a key', () => {
		const provider = createTranscriptionProvider(
			mergeSettings({
				transcriptionProvider: 'deepgram',
				deepgramApiKey: 'dg-test',
			}),
		);
		expect(provider.id).toBe('deepgram');
		expect(provider.capabilities.acceptsOriginalContainer).toBe(true);
		expect(provider.capabilities.supportsDiarization).toBe(true);
	});

	it('requires a key for every LLM provider', () => {
		expect(() =>
			createLlmProvider(
				mergeSettings({
					llmProvider: 'anthropic',
					anthropicApiKey: '',
				}),
			),
		).toThrow(ProviderConfigError);
		expect(() =>
			createLlmProvider(
				mergeSettings({ llmProvider: 'gemini', geminiApiKey: '' }),
			),
		).toThrow(ProviderConfigError);
		expect(() =>
			createLlmProvider(
				mergeSettings({
					llmProvider: 'openai-compatible',
					whisperApiKey: '',
				}),
			),
		).toThrow(ProviderConfigError);
	});

	it('builds each LLM provider from its shared vendor key', () => {
		expect(
			createLlmProvider(
				mergeSettings({
					llmProvider: 'openai-compatible',
					whisperApiKey: 'sk-test',
				}),
			).id,
		).toBe('openai-compatible');
		expect(
			createLlmProvider(
				mergeSettings({
					llmProvider: 'anthropic',
					anthropicApiKey: 'ak-test',
				}),
			).id,
		).toBe('anthropic');
		expect(
			createLlmProvider(
				mergeSettings({
					llmProvider: 'gemini',
					geminiApiKey: 'gm-test',
				}),
			).id,
		).toBe('gemini');
	});
});
