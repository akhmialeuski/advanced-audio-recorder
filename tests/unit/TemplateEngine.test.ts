import {
	TemplateEngine,
	TemplateRenderError,
} from 'src/templates/TemplateEngine';
import type { TemplateCatalog } from 'src/templates/templateCatalog';
import { describeCheck } from 'src/templates/templateAnalysis';
import type { TemplateHelper } from 'src/templates/templateHelpers';

/** What the templates below may name: a meeting with turns and properties. */
const CATALOG: TemplateCatalog = [
	{ name: 'title', description: 'Note title' },
	{ name: 'participants', description: 'Names' },
	{
		name: 'turns',
		description: 'Speaker turns',
		fields: [
			{ name: 'speaker', description: 'Who spoke' },
			{ name: 'text', description: 'What was said' },
		],
	},
	{ name: 'properties', description: 'Frontmatter', open: true },
];

/**
 * The engine under test, optionally with a feature's own helper.
 * @param extra - Helpers added to the shared set
 */
function createSut(extra: readonly TemplateHelper[] = []): TemplateEngine {
	return new TemplateEngine(extra);
}

describe('TemplateEngine.render', () => {
	it('fills variables without escaping Markdown', () => {
		const engine = createSut();

		const text = engine.render('# {{title}}', { title: 'Q&A <draft>' });

		expect(text).toBe('# Q&A <draft>');
	});

	it('takes the else branch of a condition on an empty list', () => {
		const engine = createSut();

		const text = engine.render(
			'{{#if participants}}With {{join participants ", "}}{{else}}Solo{{/if}}',
			{ participants: [] },
		);

		expect(text).toBe('Solo');
	});

	it('repeats a block for every diarized turn', () => {
		const engine = createSut();

		const text = engine.render(
			'{{#each turns}}**{{speaker}}**: {{text}}\n{{/each}}',
			{
				turns: [
					{ speaker: 'Anna', text: 'Hi.' },
					{ speaker: 'Ben', text: 'Hello.' },
				],
			},
			CATALOG,
		);

		expect(text).toBe('**Anna**: Hi.\n**Ben**: Hello.\n');
	});

	it('accepts the core Templates date notation', () => {
		const engine = createSut();

		const text = engine.render('{{date:YYYY}}', {});

		expect(text).toBe(String(new Date().getFullYear()));
	});

	it('leaves an unknown name in the output as typed', () => {
		const engine = createSut();

		const text = engine.render(
			'Return {"owner": "{{owner}}"} for {{title}}',
			{ title: 'Sync', owner: 'leaked' },
			CATALOG,
		);

		expect(text).toBe('Return {"owner": "{{owner}}"} for Sync');
	});

	it('leaves an unknown field of a turn as typed inside the loop', () => {
		const engine = createSut();

		const text = engine.render(
			'{{#each turns}}{{speaker}} {{mood}}{{/each}}',
			{ turns: [{ speaker: 'Anna', mood: 'x' }] },
			CATALOG,
		);

		expect(text).toBe('Anna {{mood}}');
	});

	it('reads any property of an open variable', () => {
		const engine = createSut();

		const text = engine.render(
			'{{properties.project}}',
			{ properties: { project: 'Atlas' } },
			CATALOG,
		);

		expect(text).toBe('Atlas');
	});

	it('looks every name up when no catalogue is given', () => {
		const engine = createSut();

		const text = engine.render('{{anything}}', { anything: 'found' });

		expect(text).toBe('found');
	});

	it('runs a helper a feature registered', () => {
		const engine = createSut([
			{
				name: 'shout',
				description: 'Loud',
				example: '{{shout title}}',
				fn: (value: unknown) => `${String(value)}!`,
			},
		]);

		const text = engine.render('{{shout title}}', { title: 'Go' }, CATALOG);

		expect(text).toBe('Go!');
	});

	it('reports a broken template with its line', () => {
		const engine = createSut();

		const render = (): string =>
			engine.render('ok\n{{#if title}}x{{/each}}', {}, CATALOG);

		expect(render).toThrow(
			expect.objectContaining({
				name: 'TemplateRenderError',
				location: { line: 2, column: 4 },
			}) as Error,
		);
	});

	it('reports a call of a missing helper as a render error', () => {
		const engine = createSut();

		const render = (): string => engine.render('{{nope 1}}', {});

		expect(render).toThrow(TemplateRenderError);
	});

	it('renders a cached template again with new values', () => {
		const engine = createSut();
		engine.render('{{title}}', { title: 'First' });

		const text = engine.render('{{title}}', { title: 'Second' });

		expect(text).toBe('Second');
	});

	it('keeps rendering once the cache has evicted old templates', () => {
		const engine = createSut();
		for (let index = 0; index < 40; index += 1) {
			engine.render(`${String(index)} {{title}}`, { title: 't' });
		}

		const text = engine.render('0 {{title}}', { title: 'back' });

		expect(text).toBe('0 back');
	});
});

describe('TemplateEngine.validate', () => {
	it('finds nothing wrong with a template that uses only known names', () => {
		const engine = createSut();

		const problems = engine.validate(
			'# {{title}}\n{{#each turns}}{{speaker}} {{@index}} {{../title}}{{/each}}',
			CATALOG,
		);

		expect(problems).toEqual([]);
	});

	it('warns about an unknown variable with its place', () => {
		const engine = createSut();

		const problems = engine.validate('line\n  {{titel}}', CATALOG);

		expect(problems).toEqual([
			{
				severity: 'warning',
				message: 'Unknown variable "titel".',
				location: { line: 2, column: 3 },
			},
		]);
	});

	it('names a syntax error with its line and column', () => {
		const engine = createSut();

		const problems = engine.validate('a\n\n{{#if title}x', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({
				severity: 'error',
				location: { line: 3, column: 13 },
			}),
		]);
	});

	it('refuses an unknown helper called with arguments', () => {
		const engine = createSut();

		const problems = engine.validate('{{shout title}}', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({
				severity: 'error',
				message: 'Unknown helper "shout".',
			}),
		]);
	});

	it('refuses an unknown helper inside a nested call', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{#if (bigger title 1)}}x{{/if}}',
			CATALOG,
		);

		expect(problems).toEqual([
			expect.objectContaining({ message: 'Unknown helper "bigger".' }),
		]);
	});

	it('refuses a block on a name that is neither a helper nor a variable', () => {
		const engine = createSut();

		const problems = engine.validate('{{#part "x"}}y{{/part}}', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({
				severity: 'error',
				message: 'Unknown helper or variable "part".',
			}),
		]);
	});

	it('refuses a partial', () => {
		const engine = createSut();

		const problems = engine.validate('{{> header}}', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({
				message: 'Partials and decorators are not supported.',
			}),
		]);
	});

	it('does not check names inside a value whose shape is unknown', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{#each participants}}{{whatever}}{{/each}}{{#with properties}}{{x}}{{/with}}',
			CATALOG,
		);

		expect(problems).toEqual([]);
	});

	it('accepts a literal output and a loop over a literal', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{"text"}}{{#each 3}}{{anything}}{{/each}}{{#each title}}{{x}}{{/each}}',
			CATALOG,
		);

		expect(problems).toEqual([]);
	});

	it('does not check the items of an unknown list', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{#each nothing}}{{x}}{{/each}}',
			CATALOG,
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			'Unknown variable "nothing".',
		]);
	});

	it('checks the fields of a section opened on a variable', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{#turns}}{{speker}}{{/turns}}',
			CATALOG,
		);

		expect(problems).toEqual([
			expect.objectContaining({ message: 'Unknown variable "speker".' }),
		]);
	});

	it('warns about an unknown argument of a helper', () => {
		const engine = createSut();

		const problems = engine.validate('{{upper titel}}', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({ message: 'Unknown variable "titel".' }),
		]);
	});

	it('resolves the root and the length of a list', () => {
		const engine = createSut();

		const problems = engine.validate(
			'{{#each turns}}{{@root.title}}{{/each}}{{turns.length}}{{@root}}',
			CATALOG,
		);

		expect(problems).toEqual([]);
	});

	it('warns about an unknown data variable and a path above the top', () => {
		const engine = createSut();

		const problems = engine.validate('{{@foo}}{{../../title}}', CATALOG);

		expect(problems.map((problem) => problem.message)).toEqual([
			'Unknown variable "@foo".',
			'Unknown variable "../../title".',
		]);
	});

	it('warns about an unknown field below a known object', () => {
		const engine = createSut();

		const problems = engine.validate('{{turns.mood}}', CATALOG);

		expect(problems).toEqual([
			expect.objectContaining({
				message: 'Unknown variable "turns.mood".',
			}),
		]);
	});

	it('lists the shared helpers with the ones a feature added', () => {
		const engine = createSut([
			{ name: 'extra', description: 'd', example: 'e', fn: () => '' },
		]);

		const names = engine.helpers.map((helper) => helper.name);

		expect(names).toEqual(expect.arrayContaining(['eq', 'date', 'extra']));
	});
});

describe('describeCheck', () => {
	it('says when nothing was found', () => {
		expect(describeCheck([])).toBe('No problems found.');
	});

	it('counts the problems and names the first with its place', () => {
		const text = describeCheck([
			{
				severity: 'warning',
				message: 'Unknown variable "a".',
				location: { line: 1, column: 2 },
			},
			{ severity: 'error', message: 'b' },
		]);

		expect(text).toBe(
			'2 problems. Line 1, column 2: Unknown variable "a".',
		);
	});

	it('names a single problem without a place', () => {
		expect(describeCheck([{ severity: 'error', message: 'Broken.' }])).toBe(
			'1 problem. Broken.',
		);
	});
});
