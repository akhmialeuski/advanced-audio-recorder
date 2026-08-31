/**
 * Tests for the segment-level transcript translation. The property that
 * matters is correspondence: every segment keeps its own start, end, and
 * speaker whatever the model answers, because a translated subtitle file is
 * worthless the moment a line slips against the clock.
 */

import { TranscriptTranslator } from 'src/transcription/llm/TranscriptTranslator';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type {
	Transcript,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { completed } from '../helpers/llmDoubles';
import { at } from '../helpers/assertions';

const SETTINGS: AudioRecorderSettings = mergeSettings({
	llmPostProcessTask: 'translate',
	llmTranslateTargetLanguage: 'Spanish',
});

/** A transcript of the given lines, one segment per minute. */
function transcriptOf(
	lines: readonly (string | [string, string])[],
): Transcript {
	return {
		segments: lines.map((line, index): TranscriptSegment => {
			const [text, speaker] = Array.isArray(line)
				? line
				: [line, undefined];
			return {
				start: index * 60,
				end: index * 60 + 59,
				text,
				...(speaker ? { speaker } : {}),
			};
		}),
		speakers: [],
		language: 'en',
	};
}

interface Sut {
	translator: TranscriptTranslator;
	prompts: string[];
}

/**
 * A translator over a provider that answers with whatever the script says
 * for each successive call.
 * @param transcript - The transcript to translate
 * @param answers - One answer per call, in order
 * @param maxTokens - Output ceiling, which decides the chunking
 * @returns The translator and the user prompts it sent
 */
function createSut(
	transcript: Transcript,
	answers: readonly string[],
	maxTokens = 32000,
): Sut {
	const prompts: string[] = [];
	let call = 0;
	const llm: LlmProvider = {
		id: 'openai-compatible',
		label: 'Fake',
		complete: (prompt) => {
			prompts.push(prompt.user);
			const answer = answers[Math.min(call, answers.length - 1)] ?? '';
			call++;
			return Promise.resolve(completed(answer));
		},
	};
	return {
		translator: new TranscriptTranslator({
			transcript,
			settings: SETTINGS,
			llm,
			maxTokens,
		}),
		prompts,
	};
}

describe('translating a transcript segment by segment', () => {
	it('puts each translated line back on the segment it came from', async () => {
		const source = transcriptOf(['Hello there', 'How are you']);
		const { translator } = createSut(source, ['0||Hola\n1||Como estas']);

		const { transcript: result } = await translator.translate();

		expect(result.segments).toEqual([
			{ start: 0, end: 59, text: 'Hola' },
			{ start: 60, end: 119, text: 'Como estas' },
		]);
	});

	it('keeps the timings and the speakers whatever the model answers', async () => {
		const source = transcriptOf([
			['Hello there', 'Speaker 1'],
			['How are you', 'Speaker 2'],
		]);
		// The model rewrote the speaker field and reordered the lines
		const { translator } = createSut(source, [
			'1|Hablante 2|Como estas\n0|Hablante 1|Hola',
		]);

		const { transcript: result } = await translator.translate();

		expect(result.segments).toEqual([
			{ start: 0, end: 59, text: 'Hola', speaker: 'Speaker 1' },
			{ start: 60, end: 119, text: 'Como estas', speaker: 'Speaker 2' },
		]);
	});

	it('names the language it translated into', async () => {
		const { translator } = createSut(transcriptOf(['Hello']), ['0||Hola']);

		expect((await translator.translate()).language).toBe('Spanish');
	});

	it('translates into English when no language is configured', async () => {
		const translator = new TranscriptTranslator({
			transcript: transcriptOf(['Hola']),
			settings: mergeSettings({ llmTranslateTargetLanguage: '  ' }),
			llm: {
				id: 'openai-compatible',
				label: 'Fake',
				complete: () => Promise.resolve(completed('0||Hello')),
			},
			maxTokens: 32000,
		});

		expect((await translator.translate()).language).toBe('English');
	});

	it('sends the segments as numbered lines with their speakers', async () => {
		const source = transcriptOf([['Hello there', 'Speaker 1'], 'And you']);
		const { translator, prompts } = createSut(source, [
			'0|Speaker 1|Hola\n1||Y tu',
		]);

		await translator.translate();

		expect(at(prompts, 0)).toBe('0|Speaker 1|Hello there\n1||And you');
	});

	it('flattens a segment that spans lines, so one segment is one line', async () => {
		const source = transcriptOf(['Hello\nthere']);
		const { translator, prompts } = createSut(source, ['0||Hola']);

		await translator.translate();

		expect(at(prompts, 0)).toBe('0||Hello there');
	});
});

describe('an answer that does not line up', () => {
	/** Silences the warning the mismatch path writes. */
	function quietWarn(): jest.SpyInstance {
		return jest.spyOn(console, 'warn').mockImplementation(() => {
			// The recovered transcript is the assertion.
		});
	}

	it('asks again when the model dropped a line', async () => {
		const warn = quietWarn();
		const source = transcriptOf(['Hello', 'World']);
		const { translator, prompts } = createSut(source, [
			'0||Hola',
			'0||Hola\n1||Mundo',
		]);

		const { transcript: result } = await translator.translate();

		expect(prompts).toHaveLength(2);
		expect(result.segments.map((s) => s.text)).toEqual(['Hola', 'Mundo']);
		warn.mockRestore();
	});

	it('keeps the original text of a line the model never answered for', async () => {
		const warn = quietWarn();
		const source = transcriptOf(['Hello', 'World']);
		const { translator } = createSut(source, ['0||Hola']);

		const { transcript: result } = await translator.translate();

		// A partly translated transcript with correct timings beats one whose
		// lines have slipped
		expect(result.segments.map((s) => s.text)).toEqual(['Hola', 'World']);
		warn.mockRestore();
	});

	it.each([
		{ case: 'a line with no fields', answer: 'Hola' },
		{ case: 'a line numbered with words', answer: 'one||Hola' },
		{ case: 'a preamble the model added', answer: 'Here you go:\n0||Hola' },
	])('ignores $case', async ({ answer }) => {
		const warn = quietWarn();
		const { translator } = createSut(transcriptOf(['Hello']), [answer]);

		const { transcript: result } = await translator.translate();

		expect(at(result.segments, 0).text).toBe(
			answer.includes('0||') ? 'Hola' : 'Hello',
		);
		warn.mockRestore();
	});

	it('ignores a line naming a segment this call did not ask about', async () => {
		const warn = quietWarn();
		const source = transcriptOf(['Hello', 'World']);
		const { translator } = createSut(source, [
			'0||Hola\n1||Mundo\n7||Invented',
		]);

		const { transcript: result } = await translator.translate();

		expect(result.segments).toHaveLength(2);
		warn.mockRestore();
	});

	it('keeps the original for a line the model answered with nothing', async () => {
		const warn = quietWarn();
		const { translator } = createSut(transcriptOf(['Hello']), ['0||']);

		expect(
			at((await translator.translate()).transcript.segments, 0).text,
		).toBe('Hello');
		warn.mockRestore();
	});
});

describe('a transcript too long for one answer', () => {
	it('splits it into calls that fit the output ceiling', async () => {
		const source = transcriptOf(['Hello', 'World', 'Again']);
		// Tiny ceiling, so every line is its own call
		const { translator, prompts } = createSut(
			source,
			['0||Hola', '1||Mundo', '2||Otra vez'],
			8,
		);

		const { transcript: result } = await translator.translate();

		expect(prompts).toHaveLength(3);
		expect(result.segments.map((s) => s.text)).toEqual([
			'Hola',
			'Mundo',
			'Otra vez',
		]);
	});

	it('numbers a later chunk by its place in the transcript, not in the chunk', async () => {
		const source = transcriptOf(['Hello', 'World']);
		const { translator, prompts } = createSut(
			source,
			['0||Hola', '1||Mundo'],
			8,
		);

		await translator.translate();

		// The second call still says 1, so its answer lands on the second
		// segment rather than overwriting the first
		expect(at(prompts, 1)).toBe('1||World');
	});

	it('sends one call for a transcript that fits', async () => {
		const source = transcriptOf(['Hello', 'World', 'Again']);
		const { translator, prompts } = createSut(source, [
			'0||Hola\n1||Mundo\n2||Otra vez',
		]);

		await translator.translate();

		expect(prompts).toHaveLength(1);
	});

	it('sends nothing for a transcript with no segments', async () => {
		const { translator, prompts } = createSut(transcriptOf([]), ['']);

		expect((await translator.translate()).transcript.segments).toEqual([]);
		expect(prompts).toHaveLength(0);
	});
});
