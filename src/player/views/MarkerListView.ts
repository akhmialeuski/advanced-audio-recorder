/**
 * Marker and chapter UI for the enhanced audio player: the tick overlay on
 * the seek area and the editable/read-only list below the controls. Rendering
 * and event delegation live here so the player coordinator stays focused on
 * playback and persistence; everything audio- or storage-coupled is passed in
 * as callbacks. The owning player remains the single source of truth for the
 * marker data — this view only renders what it is given and reports user
 * intent back. Handlers are delegated once per container so rebuilding rows or
 * ticks never accumulates per-element listeners.
 * @module player/views/MarkerListView
 */

import { setIcon } from 'obsidian';
import { formatTimecode } from '../../utils/TimeUtils';
import {
	activeMarkerIndex,
	markerRows,
	sortMarkers,
	type MarkerKind,
	type MarkerRow,
	type PlayerMarker,
} from '../markers/markerModel';

/**
 * Debounce before persisting a marker rename, so a rename is saved and synced
 * shortly after typing even when no change/blur event fires (e.g. toggling
 * edit/preview by hotkey), without writing on every keystroke.
 */
const RENAME_DEBOUNCE_MS = 400;

/** Lifecycle hooks the view borrows from the owning render child. */
export interface MarkerListHost {
	/** Registers a cleanup callback that runs on the player's unload. */
	register(cleanup: () => void): void;
	/** Registers an auto-cleaned DOM listener. */
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		callback: (event: HTMLElementEventMap[K]) => void,
	): void;
}

/** Actions the view invokes in response to user interaction. */
export interface MarkerListCallbacks {
	/** Seek to a marker/chapter time (without forcing playback). */
	onJump(time: number): void;
	/** Delete the marker with the given id. */
	onDelete(id: string): void;
	/** Persist a renamed marker. */
	onRename(id: string, label: string): void;
	/** Add a marker/chapter at a clicked time (double-click, edit only). */
	onAddAt(time: number, kind: MarkerKind): void;
	/** Resolve a viewport X coordinate to a playback time, or null. */
	timeAtClientX(clientX: number): number | null;
}

/**
 * Renders and drives the marker/chapter overlay and list for one player.
 */
export class MarkerListView {
	private overlayEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	/** Row elements in sorted order, for the active-segment highlight. */
	private rowEls: HTMLElement[] = [];
	private markers: PlayerMarker[] = [];
	private editable = false;
	/** Pending debounced rename-persist timer. */
	private renameTimer = 0;

	/**
	 * @param host - Lifecycle hooks from the owning render child
	 * @param callbacks - Actions invoked on user interaction
	 */
	constructor(
		private readonly host: MarkerListHost,
		private readonly callbacks: MarkerListCallbacks,
	) {}

	/** Replaces the marker data the view renders from. */
	setMarkers(markers: PlayerMarker[]): void {
		this.markers = markers;
	}

	/** Sets whether editing affordances (rename, delete, add) are offered. */
	setEditable(editable: boolean): void {
		this.editable = editable;
	}

	/**
	 * Creates the tick overlay inside the seek area and wires tick jumps plus
	 * double-click-to-add. One delegated handler serves every tick, so
	 * rebuilding ticks never adds listeners.
	 * @param seekEl - The seek area element
	 */
	mountOverlay(seekEl: HTMLElement): void {
		this.overlayEl = seekEl.createDiv({ cls: 'aar-player-markers' });
		this.host.registerDomEvent(this.overlayEl, 'pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			const time = this.tickTime(event);
			if (time !== null) {
				// Keep the seek handler on the parent from firing too
				event.stopPropagation();
				this.callbacks.onJump(time);
			}
		});
		// Double-clicking the track drops a bookmark (edit mode only)
		this.host.registerDomEvent(seekEl, 'dblclick', (event) => {
			if (!this.editable) {
				return;
			}
			const time = this.callbacks.timeAtClientX(event.clientX);
			if (time !== null) {
				this.callbacks.onAddAt(time, 'bookmark');
			}
		});
	}

	/**
	 * Creates the marker list container and wires delegated jump/delete and
	 * debounced rename handling. Rows themselves carry no listeners.
	 * @param container - Element to append the list to
	 */
	mountList(container: HTMLElement): void {
		this.listEl = container.createDiv({ cls: 'aar-player-marker-list' });
		this.host.registerDomEvent(this.listEl, 'click', (event) => {
			const target = (
				event.target as HTMLElement | null
			)?.closest<HTMLElement>('[data-action]');
			const id = target?.dataset.markerId;
			if (!target || !id) {
				return;
			}
			if (target.dataset.action === 'jump') {
				const marker = this.markers.find((m) => m.id === id);
				if (marker) {
					this.callbacks.onJump(marker.time);
				}
			} else if (target.dataset.action === 'delete') {
				this.callbacks.onDelete(id);
			}
		});
		// Persist a rename shortly after typing (debounced), so the change is
		// saved and synced even when no change/blur event fires
		this.host.registerDomEvent(this.listEl, 'input', (event) => {
			const input = event.target as HTMLInputElement | null;
			const id = input?.dataset.markerId;
			if (input && id && input.dataset.action === 'rename') {
				const value = input.value;
				window.clearTimeout(this.renameTimer);
				this.renameTimer = window.setTimeout(() => {
					this.callbacks.onRename(id, value);
				}, RENAME_DEBOUNCE_MS);
			}
		});
		this.host.registerDomEvent(this.listEl, 'change', (event) => {
			const input = event.target as HTMLInputElement | null;
			const id = input?.dataset.markerId;
			if (input && id && input.dataset.action === 'rename') {
				window.clearTimeout(this.renameTimer);
				this.callbacks.onRename(id, input.value);
			}
		});
		this.host.register(() => {
			window.clearTimeout(this.renameTimer);
		});
	}

	/**
	 * Rebuilds the ticks and the list. Ticks are positioned only when the
	 * duration is known; the list always rebuilds so labels and timecodes stay
	 * current.
	 * @param durationSeconds - Track duration, or null when unknown
	 * @param currentTime - Current playback position, for the active highlight
	 */
	render(durationSeconds: number | null, currentTime: number): void {
		this.renderTicks(durationSeconds);
		this.renderList(durationSeconds);
		this.updateActive(currentTime);
	}

	/**
	 * Rebuilds only the tick overlay (used after a rename, so the list input
	 * keeps focus while the tick tooltip refreshes).
	 * @param durationSeconds - Track duration, or null when unknown
	 */
	refreshTicks(durationSeconds: number | null): void {
		this.renderTicks(durationSeconds);
	}

	/**
	 * Moves the active-segment highlight to the row whose segment contains the
	 * current position. Cheap enough for every timeupdate.
	 * @param currentTime - Current playback position in seconds
	 */
	updateActive(currentTime: number): void {
		if (this.rowEls.length === 0) {
			return;
		}
		const index = activeMarkerIndex(sortMarkers(this.markers), currentTime);
		this.rowEls.forEach((rowEl, i) => {
			rowEl.toggleClass('is-active', i === index);
		});
	}

	/**
	 * Resolves the marker time stored on a tick from a delegated overlay
	 * pointer event, or null when the target is not a tick.
	 * @param event - Pointer event on the overlay
	 */
	private tickTime(event: PointerEvent): number | null {
		const target = event.target as HTMLElement | null;
		const tick = target?.closest<HTMLElement>('.aar-player-tick');
		if (!tick?.dataset.time) {
			return null;
		}
		const time = Number(tick.dataset.time);
		return Number.isFinite(time) ? time : null;
	}

	/**
	 * Positions a tick (bookmarks) or boundary line (chapters) for every
	 * marker along the seek area.
	 * @param durationSeconds - Track duration, or null when unknown
	 */
	private renderTicks(durationSeconds: number | null): void {
		if (!this.overlayEl) {
			return;
		}
		this.overlayEl.empty();
		if (durationSeconds === null || durationSeconds <= 0) {
			return;
		}
		for (const marker of this.markers) {
			const left = Math.min(100, (marker.time / durationSeconds) * 100);
			const tick = this.overlayEl.createDiv({
				cls:
					marker.kind === 'chapter'
						? 'aar-player-tick aar-player-tick-chapter'
						: 'aar-player-tick aar-player-tick-bookmark',
			});
			tick.setCssProps({ '--aar-tick-left': `${String(left)}%` });
			tick.dataset.time = String(marker.time);
			tick.setAttribute(
				'aria-label',
				`${marker.label} (${formatTimecode(marker.time)})`,
			);
		}
	}

	/**
	 * Rebuilds the marker list rows. markerRows is the single source of truth
	 * for ordering and per-row actions, identical in both modes.
	 * @param durationSeconds - Track duration, or null when unknown
	 */
	private renderList(durationSeconds: number | null): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();
		this.rowEls = [];
		const rows = markerRows(this.markers, this.editable, durationSeconds);
		// One reference width for every timestamp (the recording length, or the
		// latest marker when unknown) so all rows line up
		const reference =
			durationSeconds ??
			rows.reduce((max, row) => Math.max(max, row.time), 0);
		for (const row of rows) {
			const rowEl = this.listEl.createDiv({
				cls: 'aar-player-marker-row',
			});
			this.rowEls.push(rowEl);
			if (this.editable) {
				this.buildEditableRow(rowEl, row, reference);
			} else {
				this.buildReadonlyRow(rowEl, row, reference);
			}
		}
	}

	/**
	 * Builds an editable row: jump time, kind icon, rename input, delete.
	 * @param rowEl - The row element
	 * @param row - Row model
	 * @param referenceSeconds - Duration used to align the timestamp
	 */
	private buildEditableRow(
		rowEl: HTMLElement,
		row: MarkerRow,
		referenceSeconds: number,
	): void {
		const jump = rowEl.createEl('button', {
			cls: 'aar-player-marker-time',
			text: formatTimecode(row.time, referenceSeconds),
		});
		jump.dataset.action = 'jump';
		jump.dataset.markerId = row.id;
		jump.setAttribute(
			'aria-label',
			row.kind === 'chapter' ? 'Jump to chapter' : 'Jump to marker',
		);
		setIcon(
			rowEl.createSpan({ cls: 'aar-player-marker-kind' }),
			row.kind === 'chapter' ? 'list' : 'bookmark',
		);
		const label = rowEl.createEl('input', {
			cls: 'aar-player-marker-label',
			attr: { type: 'text', value: row.label },
		});
		label.dataset.action = 'rename';
		label.dataset.markerId = row.id;
		const remove = rowEl.createEl('button', {
			cls: 'aar-player-marker-delete',
			attr: { 'aria-label': 'Delete' },
		});
		remove.dataset.action = 'delete';
		remove.dataset.markerId = row.id;
		setIcon(remove, 'trash-2');
	}

	/**
	 * Builds a read-only row: the whole row is one jump target, the label
	 * fills the width, and the segment length is shown on the right.
	 * @param rowEl - The row element
	 * @param row - Row model
	 * @param referenceSeconds - Duration used to align the timestamps
	 */
	private buildReadonlyRow(
		rowEl: HTMLElement,
		row: MarkerRow,
		referenceSeconds: number,
	): void {
		rowEl.addClass('aar-player-marker-row-clickable');
		rowEl.dataset.action = 'jump';
		rowEl.dataset.markerId = row.id;
		rowEl.setAttribute(
			'aria-label',
			row.kind === 'chapter' ? 'Jump to chapter' : 'Jump to marker',
		);
		rowEl.createSpan({
			cls: 'aar-player-marker-time',
			text: formatTimecode(row.time, referenceSeconds),
		});
		setIcon(
			rowEl.createSpan({ cls: 'aar-player-marker-kind' }),
			row.kind === 'chapter' ? 'list' : 'bookmark',
		);
		rowEl.createSpan({
			cls: 'aar-player-marker-label-static',
			text: row.label,
		});
		rowEl.createSpan({
			cls: 'aar-player-marker-segment',
			text:
				row.segmentSeconds !== null
					? formatTimecode(row.segmentSeconds, referenceSeconds)
					: '',
		});
	}
}
