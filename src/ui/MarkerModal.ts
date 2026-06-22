/**
 * Modal for naming a marker dropped during recording. The marker's time is
 * already frozen in the session buffer when this opens; the modal only edits
 * the label and kind. Confirming commits the edits; closing without
 * confirming discards the buffered draft.
 * @module ui/MarkerModal
 */

import { App, Modal, Setting } from 'obsidian';
import {
	MARKER_KIND,
	type MarkerKind,
} from '../player/markers/markerModel';
import type { RecordingMarkerHandle } from '../recording/recordingMarkers';

/**
 * Naming dialog for a recording-time marker.
 */
export class RecordingMarkerModal extends Modal {
	private readonly handle: RecordingMarkerHandle;
	private kind: MarkerKind;
	private label: string;
	private committed = false;
	private inputEl: HTMLInputElement | null = null;

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
	 * Builds the modal contents.
	 */
	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('aar-marker-modal');

		new Setting(contentEl).setName('Add marker').setHeading();

		new Setting(contentEl).setName('Type').addDropdown((dropdown) => {
			dropdown.addOption(MARKER_KIND.bookmark, 'Bookmark');
			dropdown.addOption(MARKER_KIND.chapter, 'Chapter');
			dropdown.setValue(this.kind);
			dropdown.onChange((value) => {
				const nextKind = value as MarkerKind;
				// Refresh the default label only while the user has not
				// typed a custom one, so toggling type keeps the numbering
				// sensible without clobbering manual input.
				if (this.inputEl && this.inputEl.value === this.label) {
					this.label = this.handle.defaultLabelFor(nextKind);
					this.inputEl.value = this.label;
				}
				this.kind = nextKind;
			});
		});

		new Setting(contentEl).setName('Name').addText((text) => {
			text.setValue(this.label);
			this.inputEl = text.inputEl;
			text.inputEl.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					this.confirm();
				}
			});
		});

		const actions = new Setting(contentEl);
		actions.addButton((button) =>
			button
				.setButtonText('Add')
				.setCta()
				.onClick(() => {
					this.confirm();
				}),
		);
		actions.addButton((button) =>
			button.setButtonText('Cancel').onClick(() => {
				this.close();
			}),
		);

		// Defer focus until the modal is in the DOM so select() works
		activeWindow.setTimeout(() => {
			this.inputEl?.focus();
			this.inputEl?.select();
		}, 0);
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
