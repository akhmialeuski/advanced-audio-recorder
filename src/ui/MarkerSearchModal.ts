/**
 * Searches every marker and chapter in the vault by name, so a passage can be
 * found without remembering which recording holds it. Choosing a result plays
 * that recording from the marker, through the same mechanism a timecode link
 * uses, so no playback logic lives here.
 * @module ui/MarkerSearchModal
 */

import { FuzzySuggestModal } from 'obsidian';
import type { App, FuzzyMatch } from 'obsidian';
import { MARKER_KIND } from '../markers/markerModel';
import type { MarkerHit } from '../markers/MarkerSearchIndex';
import { formatTimecode } from '../utils/TimeUtils';

/** Root class of one result row. */
const RESULT_CLASS = 'aar-marker-search-result';

/** Class of the row's first line: the marker's own name. */
const RESULT_TITLE_CLASS = 'aar-marker-search-title';

/** Class of the row's second line: where it is and what it says. */
const RESULT_META_CLASS = 'aar-marker-search-meta';

/**
 * A fuzzy search over every marker in the vault.
 */
export class MarkerSearchModal extends FuzzySuggestModal<MarkerHit> {
	/**
	 * @param app - Obsidian App instance
	 * @param hits - Every marker in the vault, already indexed
	 * @param onChoose - Plays the recording from the chosen marker
	 */
	constructor(
		app: App,
		private readonly hits: readonly MarkerHit[],
		private readonly onChoose: (hit: MarkerHit) => void,
	) {
		super(app);
		this.setPlaceholder('Search markers and chapters across the vault');
		this.emptyStateText =
			'No marker or chapter matches. Only recordings with markers are searched.';
	}

	/** Every marker the search runs over. */
	getItems(): MarkerHit[] {
		return [...this.hits];
	}

	/**
	 * What the query is matched against: the marker's own name, the recording
	 * it is in, and any note written on it, so a passage can be found by what
	 * was said about it as well as by what it was called.
	 * @param hit - The marker being ranked
	 * @returns The text the query is matched against
	 */
	getItemText(hit: MarkerHit): string {
		return [hit.label, hit.recordingName, hit.note]
			.filter((part) => part.length > 0)
			.join(' ');
	}

	/**
	 * Draws one result: the marker's name above, and below it the recording,
	 * the position, the kind, and the note.
	 * @param match - The matched marker
	 * @param el - Row element to render into
	 */
	override renderSuggestion(
		match: FuzzyMatch<MarkerHit>,
		el: HTMLElement,
	): void {
		const hit = match.item;
		el.addClass(RESULT_CLASS);
		el.createDiv({ cls: RESULT_TITLE_CLASS, text: hit.label });
		const kind = hit.kind === MARKER_KIND.chapter ? 'Chapter' : 'Bookmark';
		const where = `${kind} in ${hit.recordingName} at ${formatTimecode(hit.time)}`;
		el.createDiv({
			cls: RESULT_META_CLASS,
			text: hit.note ? `${where} - ${hit.note}` : where,
		});
	}

	/**
	 * Plays the chosen marker's recording from its position.
	 * @param hit - The chosen marker
	 */
	onChooseItem(hit: MarkerHit): void {
		this.onChoose(hit);
	}
}
