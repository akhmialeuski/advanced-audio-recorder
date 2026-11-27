/**
 * Unit tests for the note templates the plugin ships: each one checks clean
 * against the action items profile it names, and asks for the parts its kind
 * of recording is about.
 * @module tests/unit/shippedTemplates.test
 */

import {
	declaredParts,
	checkNoteTemplate,
} from 'src/templates/noteTemplateCheck';
import {
	ACTION_ITEMS_PROFILE_NAME,
	SHIPPED_TEMPLATES,
} from 'src/templates/shippedTemplates';
import { describeProblem } from 'src/templates/templateAnalysis';

describe('the shipped note templates', () => {
	it.each(SHIPPED_TEMPLATES.map((template) => [template.name, template]))(
		'%s checks clean',
		(_name, template) => {
			expect(
				checkNoteTemplate(
					template.body,
					(name) => name === ACTION_ITEMS_PROFILE_NAME,
				).map(describeProblem),
			).toEqual([]);
		},
	);

	it.each([
		[
			'Daily sync',
			['summary:bullets', 'actions:tasks', 'blockers:bullets'],
		],
		[
			'Architecture discussion',
			[
				'decisions:decisions',
				'questions:bullets',
				'actions:tasks',
				'terms:table',
			],
		],
		['Lecture', ['notes:outline', 'terms:terms', 'questions:numbered']],
		['Interview', ['topics:bullets', 'quotes:quotes', 'actions:tasks']],
		['One-on-one', ['discussed:bullets', 'actions:tasks', 'next:bullets']],
	])('%s asks for its own parts', (name, parts) => {
		const template = SHIPPED_TEMPLATES.find((each) => each.name === name);

		expect(
			declaredParts(template?.body ?? '').map(
				(part) => `${part.name ?? ''}:${part.format}`,
			),
		).toEqual(parts);
	});

	it('gives every template a fixed id of its own', () => {
		const ids = SHIPPED_TEMPLATES.map((template) => template.id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every((id) => id.startsWith('shipped-llm-template-'))).toBe(
			true,
		);
	});
});
