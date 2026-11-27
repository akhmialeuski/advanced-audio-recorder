/**
 * Unit tests for the template a run applies when nobody picked one, and the
 * sentence that names it.
 * @module tests/unit/templateRouteRun.test
 */

import { App } from 'obsidian';
import { noticeMessages } from '../mocks/obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { TemplateRouteReason } from 'src/templates/templateRouting';
import {
	routedTemplateText,
	routeRunTemplate,
} from 'src/transcription/templateRouteRun';

const settings = {
	...DEFAULT_SETTINGS,
	profiles: [
		{ id: 'daily', kind: 'llmTemplate' as const, name: 'Daily', body: '' },
	],
};

describe('routedTemplateText', () => {
	it('says first that the property named no template', () => {
		expect(
			routedTemplateText(settings, {
				templateId: 'daily',
				reason: TemplateRouteReason.Settings,
				matched: '',
				unknownName: 'Retro',
			}),
		).toBe(
			'The note\'s note-template property names "Retro", and no note template is called that, so "Daily" from the settings was used. Structured with "Daily", selected in the settings.',
		);
	});

	it('says nothing when no template applies', () => {
		expect(
			routedTemplateText(settings, {
				templateId: '',
				reason: TemplateRouteReason.Settings,
				matched: '',
			}),
		).toBe('');
	});
});

describe('routeRunTemplate', () => {
	it('leaves a run that applies no template as it is', () => {
		const run = routeRunTemplate(new App(), settings, 'a.md');

		expect(run.settings).toBe(settings);
		expect(run.announce()).toBeUndefined();
	});

	it('tells nothing of a template run when no template is there to apply', () => {
		const run = routeRunTemplate(
			new App(),
			{
				...settings,
				llmPostProcessEnabled: true,
				llmPostProcessTask: 'template',
				profiles: [],
			},
			'',
		);
		run.announce();

		expect(run.settings.selectedProfileIds.llmTemplate).toBe('');
		expect(noticeMessages()).toEqual([]);
	});
});
