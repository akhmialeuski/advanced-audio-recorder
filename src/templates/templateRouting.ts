/**
 * Which note template a run applies, read from the note it writes into.
 *
 * Picking a template by hand before every run means a daily sync structured
 * as a lecture the day the pick was not changed back. The note already says
 * what it is: a meeting note carries a tag, a daily note lives in its folder,
 * and a note can name its template outright. The order is one list, and the
 * answer says which step of it decided, since a choice made out of sight is
 * worse than one made by hand:
 *
 * 1. a pick for this run, made in a dialog (the callers' own step);
 * 2. the note's `note-template` property, naming a template;
 * 3. a tag of the note that a template declares;
 * 4. a folder the note lies in that a template declares;
 * 5. the template the settings select.
 *
 * The tag and the folder are declared on the template's own page, so a rule
 * and its template cannot drift apart. Words in the note's text are not read:
 * a long note matches almost anything, and nothing could explain the match.
 * @module templates/templateRouting
 */

import {
	ProfileKindId,
	type Profile,
	type ProfileSettings,
	profilesOfKind,
	selectedProfileId,
} from '../settings/profiles';

/** The property a note names its template in. */
export const TEMPLATE_PROPERTY = 'note-template';

/** Which step of the order decided the template. */
export const TemplateRouteReason = {
	/** The note's `note-template` property names it. */
	Property: 'property',
	/** A tag of the note is the one the template declares. */
	Tag: 'tag',
	/** The note lies in the folder the template declares. */
	Folder: 'folder',
	/** Nothing in the note decided, so the settings' selection applies. */
	Settings: 'settings',
} as const;

/** Which step decided (derived from {@link TemplateRouteReason}). */
export type TemplateRouteReason =
	(typeof TemplateRouteReason)[keyof typeof TemplateRouteReason];

/** What the order reads of a note. */
export interface RoutedNote {
	/** The note's vault path. */
	readonly path: string;
	/** Its properties; none for a note without frontmatter. */
	readonly frontmatter?: Readonly<Record<string, unknown>> | undefined;
	/** Its tags, from the body and the properties, with or without `#`. */
	readonly tags: readonly string[];
}

/** The template a run applies, and why. */
export interface TemplateRoute {
	/** Id of the template; '' when there is none. */
	readonly templateId: string;
	/** Which step decided. */
	readonly reason: TemplateRouteReason;
	/** The tag or folder that matched, '' for the other steps. */
	readonly matched: string;
	/**
	 * The name the note's property gave that no template carries, so the
	 * user is told why the property did not decide.
	 */
	readonly unknownName?: string | undefined;
}

/**
 * A tag as it is compared: without `#`, in lower case.
 * @param tag - A tag as written
 */
function tagKey(tag: string): string {
	return tag.trim().replace(/^#/, '').toLowerCase();
}

/**
 * A folder as it is compared: without slashes at either end.
 * @param folder - A folder as written
 */
function folderKey(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Whether a note's tag is the declared one or nested under it, as Obsidian
 * counts `#meeting/weekly` as a `#meeting` note.
 * @param tag - A tag of the note
 * @param declared - The tag a template declares
 */
function tagMatches(tag: string, declared: string): boolean {
	const key = tagKey(tag);
	return key === declared || key.startsWith(`${declared}/`);
}

/**
 * Whether a note lies in a folder or one nested in it. A folder whose name
 * only begins the same, such as `Meetings old` for `Meetings`, does not count.
 * @param path - The note's path
 * @param folder - The folder a template declares
 */
function inFolder(path: string, folder: string): boolean {
	return path.startsWith(`${folder}/`);
}

/**
 * The template the note's property names, by name without regard to case.
 * @param templates - Every note template
 * @param value - The property's value: a name, or a list holding one
 */
function namedTemplate(
	templates: readonly Profile[],
	value: unknown,
): { readonly name: string; readonly template: Profile | undefined } | null {
	const first: unknown = Array.isArray(value) ? value[0] : value;
	if (typeof first !== 'string' || first.trim() === '') {
		return null;
	}
	const name = first.trim();
	return {
		name,
		template: templates.find(
			(template) => template.name.toLowerCase() === name.toLowerCase(),
		),
	};
}

/**
 * The route the settings' selection gives, the last step of the order.
 * @param settings - The settings
 * @param unknownName - The name a property gave that matched nothing
 */
function bySettings(
	settings: ProfileSettings,
	unknownName?: string,
): TemplateRoute {
	return {
		templateId: selectedProfileId(settings, ProfileKindId.LlmTemplate),
		reason: TemplateRouteReason.Settings,
		matched: '',
		...(unknownName === undefined ? {} : { unknownName }),
	};
}

/**
 * The first template whose declared tag the note carries.
 * @param templates - Every note template
 * @param tags - The note's tags
 */
function byTag(
	templates: readonly Profile[],
	tags: readonly string[],
): TemplateRoute | null {
	for (const template of templates) {
		const declared = tagKey(template.routeTag ?? '');
		if (declared !== '' && tags.some((tag) => tagMatches(tag, declared))) {
			return {
				templateId: template.id,
				reason: TemplateRouteReason.Tag,
				matched: `#${declared}`,
			};
		}
	}
	return null;
}

/**
 * The template declaring the deepest folder the note lies in, so a rule for
 * `Meetings/Clients` wins over one for `Meetings` whatever their order.
 * @param templates - Every note template
 * @param path - The note's path
 */
function byFolder(
	templates: readonly Profile[],
	path: string,
): TemplateRoute | null {
	let best: { template: Profile; folder: string } | null = null;
	for (const template of templates) {
		const folder = folderKey(template.routeFolder ?? '');
		const deeper = best === null || folder.length > best.folder.length;
		if (folder !== '' && inFolder(path, folder) && deeper) {
			best = { template, folder };
		}
	}
	return best
		? {
				templateId: best.template.id,
				reason: TemplateRouteReason.Folder,
				matched: best.folder,
			}
		: null;
}

/**
 * The template a run writing into a note applies, after a pick for the run,
 * which the callers make first.
 * @param settings - The profiles and the settings' selection
 * @param note - What the note says of itself; null for a run without one
 * @returns The template and which step of the order chose it
 */
export function routeTemplate(
	settings: ProfileSettings,
	note: RoutedNote | null,
): TemplateRoute {
	if (!note) {
		return bySettings(settings);
	}
	const templates = profilesOfKind(
		settings.profiles,
		ProfileKindId.LlmTemplate,
	);
	const named = namedTemplate(
		templates,
		note.frontmatter?.[TEMPLATE_PROPERTY],
	);
	if (named?.template) {
		return {
			templateId: named.template.id,
			reason: TemplateRouteReason.Property,
			matched: '',
		};
	}
	if (named) {
		// A property is the note saying which template it wants: one naming
		// none falls back to the default, said so, rather than to a guess.
		return bySettings(settings, named.name);
	}
	return (
		byTag(templates, note.tags) ??
		byFolder(templates, note.path) ??
		bySettings(settings)
	);
}

/**
 * What chose the template, as a clause after its name, e.g. 'picked by the
 * tag #meeting of the note'.
 * @param route - The route
 */
export function routeReasonText(route: TemplateRoute): string {
	switch (route.reason) {
		case TemplateRouteReason.Property:
			return `named by the note's ${TEMPLATE_PROPERTY} property`;
		case TemplateRouteReason.Tag:
			return `picked by the note's tag ${route.matched}`;
		case TemplateRouteReason.Folder:
			return `picked by the folder ${route.matched}`;
		default:
			return 'selected in the settings';
	}
}

/**
 * The sentence telling that the note's property named no template, or ''
 * when it did not.
 * @param route - The route
 * @param used - Name of the template applied instead
 */
export function unknownTemplateText(
	route: TemplateRoute,
	used: string,
): string {
	return route.unknownName === undefined
		? ''
		: `The note's ${TEMPLATE_PROPERTY} property names "${route.unknownName}", and no note template is called that, so "${used}" from the settings was used.`;
}

/**
 * The template a rule of the note chose, for a caller that weighs it against
 * choices of its own before the settings' selection.
 * @param route - The route
 * @returns The id; undefined when only the settings decided
 */
export function noteRuleTemplateId(route: TemplateRoute): string | undefined {
	return route.reason === TemplateRouteReason.Settings
		? undefined
		: route.templateId;
}
