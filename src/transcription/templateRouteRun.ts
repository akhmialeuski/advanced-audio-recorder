/**
 * The note template a run applies when nobody picked one for it: the one the
 * note it writes into calls for, and the sentence that says so afterwards.
 *
 * The dialog picks for its run and shows the pick before it starts; every
 * other way a run starts, transcribe-on-save, the queue and the command line,
 * comes here, so a template chosen out of sight is always named once the run
 * is over.
 * @module transcription/templateRouteRun
 */

import { type App, Notice } from 'obsidian';
import {
	findProfile,
	ProfileKindId,
	setSelectedProfileId,
} from '../settings/profiles';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	routeReasonText,
	routeTemplate,
	type TemplateRoute,
	unknownTemplateText,
} from '../templates/templateRouting';
import { writesTemplateNote } from './llmPostProcess';
import { routedNoteOf } from './runFacts';

/** A run's settings with its template decided, and how to tell of it. */
export interface RoutedRun {
	/** The settings, with the template the note calls for selected. */
	readonly settings: AudioRecorderSettings;
	/** Tells which template was applied and why; does nothing for no template. */
	readonly announce: () => void;
}

/**
 * The sentence naming the template a run applied and what chose it.
 * @param settings - The run's settings, with the template selected
 * @param route - What chose it
 * @returns '' for a run with no template
 */
export function routedTemplateText(
	settings: AudioRecorderSettings,
	route: TemplateRoute,
): string {
	const template = findProfile(settings.profiles, route.templateId);
	if (template?.kind !== ProfileKindId.LlmTemplate) {
		return '';
	}
	const applied = `Structured with "${template.name}", ${routeReasonText(route)}.`;
	return [unknownTemplateText(route, template.name), applied]
		.filter((sentence) => sentence !== '')
		.join(' ');
}

/**
 * The settings a run applies with the template its note calls for.
 * @param app - Obsidian App, for the note's properties and tags
 * @param settings - The run's settings
 * @param notePath - The note the run writes into; '' for none
 */
export function routeRunTemplate(
	app: App,
	settings: AudioRecorderSettings,
	notePath: string,
): RoutedRun {
	if (!writesTemplateNote(settings)) {
		return { settings, announce: () => undefined };
	}
	const route = routeTemplate(settings, routedNoteOf(app, notePath));
	const routed = { ...settings };
	setSelectedProfileId(routed, ProfileKindId.LlmTemplate, route.templateId);
	const text = routedTemplateText(routed, route);
	return {
		settings: routed,
		announce: () => {
			if (text !== '') {
				new Notice(text);
			}
		},
	};
}
