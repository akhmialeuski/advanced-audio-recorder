/**
 * Unit tests for finding the JSON in a model's answer.
 * @module tests/unit/jsonAnswer.test
 */

import {
	extractJsonText,
	parseJsonAnswer,
} from 'src/transcription/llm/jsonAnswer';

describe('extractJsonText', () => {
	it.each([
		['Here: [1, 2] done', 'array', '[1, 2]'],
		['```json\n{"a": 1}\n```', 'object', '{"a": 1}'],
		['no brackets', 'array', null],
		['} reversed {', 'object', null],
	] as const)('reads %p as %p', (output, kind, expected) => {
		expect(extractJsonText(output, kind)).toBe(expected);
	});
});

describe('parseJsonAnswer', () => {
	it('answers the value of the kind asked for', () => {
		expect(parseJsonAnswer('x [1] y', 'array')).toEqual([1]);
		expect(parseJsonAnswer('{"a": [1]}', 'object')).toEqual({ a: [1] });
	});

	it('answers nothing for broken JSON or a value of another kind', () => {
		expect(parseJsonAnswer('{"a": }', 'object')).toBeUndefined();
		expect(parseJsonAnswer('[{"a": 1}]', 'object')).toEqual({ a: 1 });
		expect(parseJsonAnswer('[1,]', 'array')).toBeUndefined();
		expect(parseJsonAnswer('nothing', 'object')).toBeUndefined();
	});
});
