/**
 * Tests a transcription preset: its text read into the choices of a run, the
 * words a wrong line is refused in, the settings it leaves alone, and the text
 * that saves a run's choices so that reading it back makes the same run.
 * @module tests/unit/runPreset.test
 */

import {
	presetArgs,
	presetBodyOf,
	presetOptionCount,
	presetRun,
} from 'src/transcription/runPreset';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LANGUAGE_LESSON_CLEANUP_PROFILE_ID } from 'src/constants';
import { valueOrThrow } from 'src/utils/refusal';

/** Everyday settings: Deepgram, one language, no post-processing. */
const EVERYDAY = mergeSettings({
	transcriptionEnabled: true,
	transcriptionProvider: 'deepgram',
	transcriptionLanguage: 'auto',
	transcriptionDiarize: false,
	llmPostProcessEnabled: false,
});

/** A lesson, as a user would write it into a preset. */
const LESSON = [
	'# Polish with a Ukrainian-speaking tutor',
	'engine: gemini',
	'Model: gemini-4-hydrogen',
	'language: pl, uk',
	'',
	'diarize: on',
	'postprocess: on',
	'task: cleanup',
	'cleanup: Language lesson',
].join('\n');

describe('presetArgs', () => {
	it('reads one option per line, skipping remarks and blank lines', () => {
		expect(presetArgs(LESSON)).toEqual({
			value: {
				engine: 'gemini',
				model: 'gemini-4-hydrogen',
				language: 'pl, uk',
				diarize: 'on',
				postprocess: 'on',
				task: 'cleanup',
				cleanup: 'Language lesson',
			},
		});
	});

	it('keeps a colon that belongs to the value', () => {
		expect(presetArgs('participants: Team: Warsaw')).toEqual({
			value: { participants: 'Team: Warsaw' },
		});
	});

	it.each(['speed: fast', 'engine', 'language:'])(
		'refuses the line "%s", naming the options a run has',
		(line) => {
			expect(presetArgs(`engine: gemini\n${line}`)).toEqual({
				refusal: expect.stringMatching(
					/is not an option of a run\..*language.*engine.*cleanup/,
				),
			});
		},
	);

	it('reads an empty preset as one that changes nothing', () => {
		expect(presetArgs('\n  \n')).toEqual({ value: {} });
	});
});

describe('presetRun', () => {
	it('lays the preset over the settings, leaving the rest as it was', () => {
		const run = valueOrThrow(presetRun(EVERYDAY, LESSON)).apply(EVERYDAY);

		expect(run).toMatchObject({
			transcriptionProvider: 'gemini',
			geminiModel: 'gemini-4-hydrogen',
			transcriptionLanguage: 'pl, uk',
			transcriptionDiarize: true,
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
			deepgramModel: EVERYDAY.deepgramModel,
			transcriptDestination: EVERYDAY.transcriptDestination,
		});
		expect(run.selectedProfileIds.llmCleanup).toBe(
			LANGUAGE_LESSON_CLEANUP_PROFILE_ID,
		);
	});

	it('does not touch the settings it was read against', () => {
		valueOrThrow(presetRun(EVERYDAY, LESSON)).apply(EVERYDAY);

		expect(EVERYDAY.transcriptionProvider).toBe('deepgram');
	});

	it('refuses a value an option cannot take, in the words of the command line', () => {
		expect(presetRun(EVERYDAY, 'engine: whisperx')).toEqual({
			refusal: expect.stringContaining('engine=whisperx is not one of'),
		});
	});

	it('refuses a profile that no longer exists by the name the preset gives', () => {
		expect(presetRun(EVERYDAY, 'cleanup: Lectures')).toEqual({
			refusal: expect.stringContaining('No profile named "Lectures"'),
		});
	});
});

describe('presetOptionCount', () => {
	it('counts the options a preset sets', () => {
		expect(presetOptionCount(LESSON)).toBe(7);
	});

	it('answers null for text that does not read as a preset', () => {
		expect(presetOptionCount('just some words')).toBeNull();
	});
});

describe('presetBodyOf', () => {
	it('states the engine, its model, the language and the switches of a run', () => {
		const lesson = valueOrThrow(presetRun(EVERYDAY, LESSON)).apply(
			EVERYDAY,
		);

		expect(presetBodyOf(lesson).split('\n')).toEqual(
			expect.arrayContaining([
				'language: pl, uk',
				'engine: gemini',
				'model: gemini-4-hydrogen',
				'diarize: on',
				'postprocess: on',
				'task: cleanup',
				'cleanup: Language lesson',
				'participants: none',
			]),
		);
	});

	it('names the prompt profile of the task the run uses and of no other', () => {
		const body = presetBodyOf(EVERYDAY);

		expect(body).toMatch(/^cleanup: /m);
		expect(body).not.toMatch(/^(summary|translation|instruction): /m);
	});

	it('leaves out the model of an engine that has none to choose', () => {
		const local = {
			...EVERYDAY,
			transcriptionProvider: 'local-whisper' as const,
		};

		expect(presetBodyOf(local)).not.toMatch(/^model: /m);
	});

	it('saves a run that reading it back over other settings makes again', () => {
		const lesson = valueOrThrow(presetRun(EVERYDAY, LESSON)).apply(
			EVERYDAY,
		);

		const again = valueOrThrow(
			presetRun(EVERYDAY, presetBodyOf(lesson)),
		).apply(EVERYDAY);

		expect(again).toEqual(lesson);
	});
});

// The Language setting may be left empty to detect the language, and a
// preset saved then has to read back like any other.
describe('a preset saved with the language setting left empty', () => {
	it('states the language as auto and reads back', () => {
		const body = presetBodyOf({ ...EVERYDAY, transcriptionLanguage: '' });

		expect(body.split('\n')).toContain('language: auto');
		expect(presetOptionCount(body)).not.toBeNull();
	});
});
