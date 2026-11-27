/**
 * Unit tests for telling a run whose note a template writes.
 * @module tests/unit/writesTemplateNote.test
 */

import { writesTemplateNote } from 'src/transcription/llmPostProcess';

describe('writesTemplateNote', () => {
	it.each([
		[true, 'template', true],
		[false, 'template', false],
		[true, 'summary', false],
	] as const)(
		'post-processing %s with the %s task: %s',
		(llmPostProcessEnabled, llmPostProcessTask, expected) => {
			expect(
				writesTemplateNote({
					llmPostProcessEnabled,
					llmPostProcessTask,
				}),
			).toBe(expected);
		},
	);
});
