/**
 * Modal for naming a marker dropped during recording. The marker's time is
 * already frozen in the session buffer when this opens; the modal only edits
 * the label and kind. Confirming commits the edits; closing without
 * confirming discards the buffered draft.
 * @module ui/MarkerModal
 */

import { App, Modal, setIcon } from 'obsidian';
import { MARKER_KIND, type MarkerKind } from '../player/markers/markerModel';
import type { RecordingMarkerHandle } from '../recording/recordingMarkers';

/** A selectable kind option rendered as a segmented-toggle button. */
interface KindOption {
	kind: MarkerKind;
	label: string;
	icon: string;
}

const KIND_OPTIONS: KindOption[] = [
	{ kind: MARKER_KIND.bookmark, label: 'Bookmark', icon: 'bookmark' },
	{ kind: MARKER_KIND.chapter, label: 'Chapter', icon: 'list' },
];

/**
 * Naming dialog for a recording-time marker.
 */
export class RecordingMarkerModal extends Modal {
	private readonly handle: RecordingMarkerHandle;
	private kind: MarkerKind;
	private label: string;
	private committed = false;
	private inputEl: HTMLInputElement | null = null;
	private readonly kindButtons = new Map<MarkerKind, HTMLButtonElement>();

	/**
	 * @param app - The Obsidian App instance
	 * @param handle - Editing handle for the buffered marker draft
	 */
	constructor(app: App, handle: RecordingMarkerHandle) {
		super(app);
		this.handle = handle;
		this.kind = handle.initialKind;
		this.label = handle.defaultLabelFor(this.kind);
	}

	/**
	 * Builds the modal contents: a compact kind toggle and a full-width
	 * name field over a standard button row.
	 */
	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('aar-marker-modal');
		this.setTitle('Add marker');

		const toggle = contentEl.createDiv({ cls: 'aar-marker-type' });
		for (const option of KIND_OPTIONS) {
			const button = toggle.createEl('button', {
				cls: 'aar-marker-type-btn',
			});
			setIcon(
				button.createSpan({ cls: 'aar-marker-type-icon' }),
				option.icon,
			);
			button.createSpan({ text: option.label });
			button.addEventListener('click', () => {
				this.selectKind(option.kind);
			});
			this.kindButtons.set(option.kind, button);
		}

		this.inputEl = contentEl.createEl('input', {
			cls: 'aar-marker-name-input',
			type: 'text',
		});
		this.inputEl.value = this.label;
		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.confirm();
			}
		});

		const actions = contentEl.createDiv({ cls: 'modal-button-container' });
		const addButton = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Add',
		});
		addButton.addEventListener('click', () => {
			this.confirm();
		});
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		this.refreshKindButtons();
		// Defer focus until the modal is in the DOM so select() works
		window.setTimeout(() => {
			this.inputEl?.focus();
			this.inputEl?.select();
		}, 0);
	}

	/**
	 * Switches the marker kind. Refreshes the default label only while the
	 * user has not typed a custom one, so toggling type keeps the numbering
	 * sensible without clobbering manual input.
	 * @param kind - Newly selected kind
	 */
	private selectKind(kind: MarkerKind): void {
		if (kind === this.kind) {
			return;
		}
		if (this.inputEl && this.inputEl.value === this.label) {
			this.label = this.handle.defaultLabelFor(kind);
			this.inputEl.value = this.label;
		}
		this.kind = kind;
		this.refreshKindButtons();
	}

	/**
	 * Highlights the button of the active kind.
	 */
	private refreshKindButtons(): void {
		for (const [kind, button] of this.kindButtons) {
			button.toggleClass('is-active', kind === this.kind);
		}
	}

	/**
	 * Commits the current label and kind onto the draft and closes.
	 */
	private confirm(): void {
		this.handle.commit(this.inputEl?.value ?? this.label, this.kind);
		this.committed = true;
		this.close();
	}

	/**
	 * Discards the draft when the modal closes without confirmation.
	 */
	onClose(): void {
		if (!this.committed) {
			this.handle.cancel();
		}
		this.contentEl.empty();
	}
}
