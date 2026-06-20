/**
 * Tests for the smaller pure transcription helpers: chunk planning,
 * Whisper/LLM response mapping, prompt building, file paths, and
 * provider-factory validation.
 */

import { planChunks } from 'src/transcription/audioChunks';
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
import { mergeSettings } from 'src/settings/Settings';
import { TRANSCRIBE_BYTES_PER_SEC } from 'src/constants';
import { WAV_HEADER_SIZE } from 'src/recording/WavEncoder';

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
		expect(result.segments[0].text).toBe('Hello');
		expect(result.segments[0].speaker).toBe('SPEAKER_00');
		expect(result.segments[0].words?.[0].text).toBe('Hello');
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
	it('extracts OpenAI chat content', () => {
		expect(
			extractOpenAiText({ choices: [{ message: { content: ' hi ' } }] }),
		).toBe('hi');
		expect(extractOpenAiText({ choices: [] })).toBe('');
	});

	it('extracts Anthropic text blocks', () => {
		expect(
			extractAnthropicText({
				content: [
					{ type: 'text', text: 'a' },
					{ type: 'thinking', text: 'ignored' },
					{ type: 'text', text: 'b' },
				],
			}),
		).toBe('ab');
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
		expect(provider.capabilities.diarizesWholeFile).toBe(true);
	});

	it('requires an Anthropic key but not an Ollama key', () => {
		expect(() =>
			createLlmProvider(
				mergeSettings({ llmProvider: 'anthropic', llmApiKey: '' }),
			),
		).toThrow(ProviderConfigError);
		expect(
			createLlmProvider(
				mergeSettings({
					llmProvider: 'openai-compatible',
					llmApiKey: '',
				}),
			).id,
		).toBe('openai-compatible');
	});
});
