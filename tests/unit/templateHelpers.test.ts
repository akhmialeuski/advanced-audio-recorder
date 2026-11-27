import { TemplateEngine } from 'src/templates/TemplateEngine';
import { formatDuration, yamlQuote } from 'src/templates/templateHelpers';

/**
 * Renders one template through the shared helpers.
 * @param source - The template
 * @param context - The values it reads
 */
function render(source: string, context: Record<string, unknown> = {}): string {
	return new TemplateEngine().render(source, context);
}

describe('comparison and logic helpers', () => {
	it.each([
		['{{#if (eq count "3")}}y{{else}}n{{/if}}', 'y'],
		['{{#if (ne count 3)}}y{{else}}n{{/if}}', 'n'],
		['{{#if (gt count 2)}}y{{else}}n{{/if}}', 'y'],
		['{{#if (lt count 2)}}y{{else}}n{{/if}}', 'n'],
		['{{#if (gte count 3)}}y{{else}}n{{/if}}', 'y'],
		['{{#if (lte count 3)}}y{{else}}n{{/if}}', 'y'],
		['{{#if (and count name)}}y{{else}}n{{/if}}', 'n'],
		['{{#if (or name count)}}y{{else}}n{{/if}}', 'y'],
		['{{#if (not name)}}y{{else}}n{{/if}}', 'y'],
	])('renders %s as %s', (source, expected) => {
		const text = render(source, { count: 3, name: '' });

		expect(text).toBe(expected);
	});
});

describe('string helpers', () => {
	it.each([
		['{{default lang "unknown"}}', 'unknown'],
		['{{default title "unknown"}}', 'Weekly sync'],
		['{{upper title}}', 'WEEKLY SYNC'],
		['{{lower title}}', 'weekly sync'],
		['{{trim padded}}', 'x'],
		['{{truncate title 6}}', 'Weekly'],
		['{{truncate title "x"}}', ''],
		['{{replace title "\\s" "_"}}', 'Weekly_sync'],
		['{{replace title "(" "_"}}', 'Weekly sync'],
		['{{join names " & "}}', 'Anna & Ben'],
		['{{join names}}', 'Anna, Ben'],
		['{{join title ", "}}', 'Weekly sync'],
		['{{#each (split csv ",")}}[{{this}}]{{/each}}', '[a][b]'],
		['{{upper missing}}', ''],
		['{{upper 5}}', '5'],
		['{{trim obj}}', '{"a":1}'],
		['{{trim names}}', 'Anna, Ben'],
	])('renders %s as %s', (source, expected) => {
		const text = render(source, {
			title: 'Weekly sync',
			padded: '  x ',
			names: ['Anna', 'Ben'],
			csv: 'a,b',
			missing: null,
			obj: { a: 1 },
		});

		expect(text).toBe(expected);
	});
});

describe('date helpers', () => {
	it('formats a given date in a given format', () => {
		const when = new Date(2026, 8, 22, 14, 5).getTime();

		const text = render('{{date when format="DD.MM.YYYY"}} {{time when}}', {
			when,
		});

		expect(text).toBe('22.09.2026 14:05');
	});

	it('formats an ISO date with the default format', () => {
		const text = render('{{date when}}', { when: '2026-09-22T10:00:00' });

		expect(text).toBe('2026-09-22');
	});

	it('formats a Date object', () => {
		const text = render('{{date when format="YYYY"}}', {
			when: new Date(2025, 0, 1),
		});

		expect(text).toBe('2025');
	});

	it('renders nothing for a date moment cannot read', () => {
		const text = render('{{date when}}', { when: 'not a date' });

		expect(text).toBe('');
	});

	it('formats now when no date is given', () => {
		const text = render('{{time format="YYYY"}}');

		expect(text).toBe(String(new Date().getFullYear()));
	});

	it('renders a duration in seconds as a clock reading', () => {
		const text = render('{{duration seconds}}', { seconds: 3723 });

		expect(text).toBe('1:02:03');
	});
});

describe('formatDuration', () => {
	it.each([
		[0, '0:00'],
		[65.4, '1:05'],
		['600', '10:00'],
		[3600, '1:00:00'],
		[-5, '0:00'],
		['', ''],
		['abc', ''],
		[undefined, ''],
	])('reads %p as %p', (value, expected) => {
		expect(formatDuration(value)).toBe(expected);
	});
});

describe('yamlQuote', () => {
	it.each([
		['plain text', 'plain text'],
		['Q: what', '"Q: what"'],
		['- dash', '"- dash"'],
		['say "hi"', '"say \\"hi\\""'],
		['back\\slash: x', '"back\\\\slash: x"'],
		['', '""'],
		['tag #x', '"tag #x"'],
		[42, '42'],
	])('quotes %p as %p', (value, expected) => {
		expect(yamlQuote(value)).toBe(expected);
	});
});
