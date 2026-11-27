/**
 * Unit tests for the properties a note template's parts write.
 * @module tests/unit/partProperties.test
 */

import { collectParts } from 'src/templates/noteTemplate';
import { noteProperties } from 'src/templates/partProperties';

describe('noteProperties', () => {
	const specs = collectParts(
		[
			'{{#part "summary" property="summary"}}The points.{{/part}}',
			'{{#part "risks" property="risks"}}The risks.{{/part}}',
			'{{#part "body"}}In the body.{{/part}}',
		].join('\n'),
		{},
	);

	it('gives each part sent to a property its result, as text', () => {
		const results = new Map([
			['summary', '  Ship on Friday.  '],
			['risks', ''],
			['body', 'Stays in the note.'],
		]);

		// A part that found nothing leaves the property as the note had it.
		expect(noteProperties(specs, results)).toEqual({
			summary: 'Ship on Friday.',
		});
	});
});
