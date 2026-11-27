/**
 * The list of what a prompt or a note template can name.
 *
 * Opened from a profile page, next to the text being written: what is wrong
 * with that text first, with the line and column of each problem, then every
 * fact of a run and every helper with an example, and a button that copies
 * the list as a Markdown table to keep beside a template being written in a
 * note. The form follows the variable list of obsidian-citation-extended.
 * @module ui/TemplateVariablesModal
 */

import { type App, Setting } from 'obsidian';
import type { TemplateProblem } from '../templates/templateAnalysis';
import { describeProblem } from '../templates/templateAnalysis';
import type { TemplateCatalog } from '../templates/templateCatalog';
import type { TemplateHelper } from '../templates/templateHelpers';
import { PluginModal } from './PluginModal';

/** Duration in milliseconds the "Copied" confirmation stays on the button. */
const COPY_CONFIRM_MS = 2000;

/** What the dialog lists. */
export interface TemplateVariablesView {
	/** What the dialog is about, e.g. the name of the profile. */
	readonly subject: string;
	/** The facts a template can name. */
	readonly variables: TemplateCatalog;
	/** The helpers it can call. */
	readonly helpers: readonly TemplateHelper[];
	/** What is wrong with the text being edited. */
	readonly problems: readonly TemplateProblem[];
}

/** One row of a table: a name, what it is, and an example. */
interface Row {
	readonly name: string;
	readonly description: string;
	readonly example: string;
}

/**
 * The rows of the variable table. A name is shown as a template writes it.
 * @param variables - The catalogue
 */
function variableRows(variables: TemplateCatalog): Row[] {
	return variables.map((variable) => ({
		name: `{{${variable.name}}}`,
		description: variable.description,
		example: variable.example ?? '',
	}));
}

/**
 * The rows of the helper table.
 * @param helpers - The helpers
 */
function helperRows(helpers: readonly TemplateHelper[]): Row[] {
	return helpers.map((helper) => ({
		name: helper.name,
		description: helper.description,
		example: helper.example,
	}));
}

/**
 * The list as Markdown, the way the copy button hands it out.
 * @param view - What the dialog lists
 */
export function variablesMarkdown(view: TemplateVariablesView): string {
	const table = (rows: readonly Row[]): string =>
		[
			'| Name | Description | Example |',
			'| --- | --- | --- |',
			...rows.map(
				(row) =>
					`| \`${row.name}\` | ${row.description} | \`${row.example.replace(/\|/g, '\\|')}\` |`,
			),
		].join('\n');
	return [
		'## Variables',
		'',
		table(variableRows(view.variables)),
		'',
		'## Helpers',
		'',
		table(helperRows(view.helpers)),
		'',
	].join('\n');
}

/** Lists the variables and helpers a template can use. */
export class TemplateVariablesModal extends PluginModal {
	constructor(
		app: App,
		private readonly view: TemplateVariablesView,
	) {
		super(app);
	}

	override onOpen(): void {
		this.makeBodyScrollable();
		this.setDialogTitle(`Template variables: ${this.view.subject}`);
		this.renderProblems();
		this.renderTable('Variables', variableRows(this.view.variables));
		this.renderTable('Helpers', helperRows(this.view.helpers));
		this.renderActions({
			text: 'Copy list',
			cta: true,
			ref: (button) => {
				button.onClick(() => {
					void navigator.clipboard
						.writeText(variablesMarkdown(this.view))
						.then(() => {
							button.setButtonText('Copied');
							window.setTimeout(() => {
								button.setButtonText('Copy list');
							}, COPY_CONFIRM_MS);
						});
				});
			},
			onClick: () => {
				/* the ref above owns the copy handler and its feedback */
			},
		});
	}

	/** The problems of the text being edited, or that there are none. */
	private renderProblems(): void {
		new Setting(this.contentEl).setName('Check').setHeading();
		const problems = this.view.problems;
		if (problems.length === 0) {
			this.contentEl.createEl('p', {
				text: 'No problems found.',
				cls: 'aar-template-check',
			});
			return;
		}
		const list = this.contentEl.createEl('ul', {
			cls: 'aar-template-check',
		});
		for (const problem of problems) {
			list.createEl('li', { text: describeProblem(problem) });
		}
	}

	/**
	 * One table of names.
	 * @param heading - Title of the table
	 * @param rows - Its rows
	 */
	private renderTable(heading: string, rows: readonly Row[]): void {
		new Setting(this.contentEl).setName(heading).setHeading();
		const table = this.contentEl.createEl('table', {
			cls: 'aar-template-variables',
		});
		const head = table.createEl('thead').createEl('tr');
		for (const title of ['Name', 'Description', 'Example']) {
			head.createEl('th', { text: title });
		}
		const body = table.createEl('tbody');
		for (const row of rows) {
			const tr = body.createEl('tr');
			tr.createEl('td').createEl('code', { text: row.name });
			tr.createEl('td', { text: row.description });
			tr.createEl('td').createEl('code', { text: row.example });
		}
	}
}
