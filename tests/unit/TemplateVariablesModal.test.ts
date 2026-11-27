/**
 * Unit tests for the template variables dialog.
 * @module tests/unit/TemplateVariablesModal.test
 */

import { App } from 'obsidian';
import {
	TemplateVariablesModal,
	type TemplateVariablesView,
	variablesMarkdown,
} from 'src/ui/TemplateVariablesModal';
import { allEls, el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';

/**
 * What the dialog lists, with the differences a test needs.
 * @param overrides - Fields to replace
 */
function viewWith(
	overrides: Partial<TemplateVariablesView> = {},
): TemplateVariablesView {
	return {
		subject: 'Weekly summary',
		variables: [
			{ name: 'title', description: 'Note title', example: 'Sync' },
			{ name: 'properties', description: 'Properties' },
		],
		helpers: [
			{
				name: 'join',
				description: 'Joins a list',
				example: '{{join a "|"}}',
				fn: () => '',
			},
		],
		problems: [],
		...overrides,
	};
}

/**
 * The dialog, opened.
 * @param view - What it lists
 */
function createSut(view: TemplateVariablesView): TemplateVariablesModal {
	const modal = new TemplateVariablesModal(new App(), view);
	modal.onOpen();
	return modal;
}

describe('TemplateVariablesModal', () => {
	it('lists every variable as a template writes it, then every helper', () => {
		const modal = createSut(viewWith());

		const names = allEls(
			modal.contentEl,
			`${MODAL.templateVariables} tbody td:first-child code`,
		).map((code) => code.textContent);

		expect(names).toEqual(['{{title}}', '{{properties}}', 'join']);
	});

	it('says when the text has no problems', () => {
		const modal = createSut(viewWith());

		expect(el(modal.contentEl, MODAL.templateCheck).textContent).toBe(
			'No problems found.',
		);
	});

	it('lists every problem with its place', () => {
		const modal = createSut(
			viewWith({
				problems: [
					{
						severity: 'warning',
						message: 'Unknown variable "titel".',
						location: { line: 2, column: 3 },
					},
					{ severity: 'error', message: 'Broken.' },
				],
			}),
		);

		const items = allEls(modal.contentEl, `${MODAL.templateCheck} li`).map(
			(item) => item.textContent,
		);

		expect(items).toEqual([
			'Line 2, column 3: Unknown variable "titel".',
			'Broken.',
		]);
	});

	it('copies the list as Markdown', async () => {
		const writeText = jest.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		const modal = createSut(viewWith());
		const button = el<HTMLButtonElement>(
			modal.modalEl,
			`${MODAL.actions} button`,
		);

		button.click();
		await Promise.resolve();

		expect(writeText).toHaveBeenCalledWith(variablesMarkdown(viewWith()));
	});
});

describe('variablesMarkdown', () => {
	it('writes both tables with pipes in examples escaped', () => {
		const markdown = variablesMarkdown(viewWith());

		expect(markdown).toContain('| `{{title}}` | Note title | `Sync` |');
		expect(markdown).toContain(
			'| `join` | Joins a list | `{{join a "\\|"}}` |',
		);
	});
});
