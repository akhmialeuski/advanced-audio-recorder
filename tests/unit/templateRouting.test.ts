/**
 * Unit tests for which note template a run applies, read from its note.
 * @module tests/unit/templateRouting.test
 */

import {
	noSelectedProfiles,
	type Profile,
	type ProfileSettings,
} from 'src/settings/profiles';
import {
	noteRuleTemplateId,
	routeReasonText,
	routeTemplate,
	type RoutedNote,
	TemplateRouteReason,
	unknownTemplateText,
} from 'src/templates/templateRouting';

/**
 * A note template with the given rules.
 * @param id - Id and name of the template
 * @param rules - The tag and folder it declares
 */
function template(
	id: string,
	rules: Pick<Profile, 'routeTag' | 'routeFolder'> = {},
): Profile {
	return { id, kind: 'llmTemplate', name: id, body: '', ...rules };
}

/**
 * Settings holding the templates, with `daily` selected.
 * @param profiles - The templates
 */
function settingsOf(profiles: Profile[]): ProfileSettings {
	return {
		profiles,
		selectedProfileIds: { ...noSelectedProfiles(), llmTemplate: 'daily' },
	};
}

/**
 * A note at the path, with the tags and properties given.
 * @param path - Its path
 * @param more - Its tags and properties
 */
function note(path: string, more: Partial<RoutedNote> = {}): RoutedNote {
	return { path, tags: [], ...more };
}

const settings = settingsOf([
	template('daily'),
	template('Meeting', { routeTag: '#Meeting' }),
	template('Clients', { routeFolder: '/Meetings/Clients/' }),
	template('Meetings', { routeFolder: 'Meetings' }),
	template('Lecture', { routeTag: 'lecture' }),
]);

describe('routeTemplate', () => {
	it('applies the selected template to a run without a note', () => {
		expect(routeTemplate(settings, null)).toEqual({
			templateId: 'daily',
			reason: TemplateRouteReason.Settings,
			matched: '',
		});
	});

	it.each([
		['a name', 'lecture'],
		['a list holding a name', ['Lecture', 'Meeting']],
	])(
		'applies the template the property names as %s, whatever the rules say',
		(_label, value) => {
			const route = routeTemplate(
				settings,
				note('Meetings/a.md', {
					frontmatter: { 'note-template': value },
					tags: ['meeting'],
				}),
			);

			expect(route).toEqual({
				templateId: 'Lecture',
				reason: TemplateRouteReason.Property,
				matched: '',
			});
		},
	);

	it('falls back to the settings, naming the property, when no template has its name', () => {
		const route = routeTemplate(
			settings,
			note('Meetings/a.md', {
				frontmatter: { 'note-template': ' Retro ' },
				tags: ['meeting'],
			}),
		);

		expect(route).toEqual({
			templateId: 'daily',
			reason: TemplateRouteReason.Settings,
			matched: '',
			unknownName: 'Retro',
		});
		expect(unknownTemplateText(route, 'daily')).toBe(
			`The note's note-template property names "Retro", and no note template is called that, so "daily" from the settings was used.`,
		);
	});

	it.each([[''], [3], [[]]])(
		'reads a property holding %p as no property',
		(value) => {
			const route = routeTemplate(
				settings,
				note('Inbox/a.md', { frontmatter: { 'note-template': value } }),
			);

			expect(route.reason).toBe(TemplateRouteReason.Settings);
			expect(route.unknownName).toBeUndefined();
		},
	);

	it.each([['#meeting'], ['Meeting/weekly'], ['MEETING']])(
		'applies the template declaring a tag the note carries as %s',
		(tag) => {
			expect(
				routeTemplate(settings, note('Meetings/a.md', { tags: [tag] })),
			).toEqual({
				templateId: 'Meeting',
				reason: TemplateRouteReason.Tag,
				matched: '#meeting',
			});
		},
	);

	it('does not read a tag that only begins as the declared one does', () => {
		const route = routeTemplate(
			settings,
			note('Inbox/a.md', { tags: ['meetings'] }),
		);

		expect(route.reason).toBe(TemplateRouteReason.Settings);
	});

	it.each([
		['Meetings/a.md', 'Meetings'],
		['Meetings/2026/a.md', 'Meetings'],
		['Meetings/Clients/a.md', 'Meetings/Clients'],
		['Meetings/Clients/Acme/a.md', 'Meetings/Clients'],
	])('applies to %s the template of the deepest folder', (path, folder) => {
		const route = routeTemplate(settings, note(path));

		expect(route.reason).toBe(TemplateRouteReason.Folder);
		expect(route.matched).toBe(folder);
	});

	it('does not count a folder whose name only begins the same', () => {
		expect(routeTemplate(settings, note('Meetings old/a.md')).reason).toBe(
			TemplateRouteReason.Settings,
		);
	});
});

describe('routeReasonText', () => {
	it.each([
		[
			TemplateRouteReason.Property,
			'',
			"named by the note's note-template property",
		],
		[
			TemplateRouteReason.Tag,
			'#meeting',
			"picked by the note's tag #meeting",
		],
		[
			TemplateRouteReason.Folder,
			'Meetings',
			'picked by the folder Meetings',
		],
		[TemplateRouteReason.Settings, '', 'selected in the settings'],
	])('says what %s chose', (reason, matched, text) => {
		expect(routeReasonText({ templateId: 'x', reason, matched })).toBe(
			text,
		);
	});
});

describe('noteRuleTemplateId', () => {
	it('gives the template only when a rule of the note chose it', () => {
		expect(
			noteRuleTemplateId(routeTemplate(settings, note('Meetings/a.md'))),
		).toBe('Meetings');
		expect(
			noteRuleTemplateId(routeTemplate(settings, null)),
		).toBeUndefined();
	});
});
