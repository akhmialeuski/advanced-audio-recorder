/**
 * Modal for naming a marker dropped during recording. The marker's time is
 * already frozen in the session buffer when this opens; the modal only edits
 * the label and kind. Confirming commits the edits; closing without
 * confirming discards the buffered draft.
 * @module ui/MarkerModal
 */

import { App, setIcon } from 'obsidian';
import { PluginModal } from './PluginModal';
import { MARKER_KIND, type MarkerKind } from '../markers/markerModel';
import type { RecordingMarkerHandle } from '../recording/api';

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
export class RecordingMarkerModal extends PluginModal {
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
		// Enter confirms through the dialog's own keymap scope rather than a
		// listener on the field, so it goes through Obsidian's key handling
		// like every other dialog's Enter, and leaves with the dialog's scope.
		// Registered here rather than in onOpen so a reopened dialog does not
		// stack a second handler.
		this.scope.register([], 'Enter', (evt) => this.confirmOnEnter(evt));
	}

	/**
	 * Confirms on Enter in the name field, the only place it ever confirmed.
	 * Enter on a focused kind button or on Cancel is left to do what pressing
	 * that button does, which is why the handler declines it rather than
	 * preventing it.
	 *
	 * An Enter that ends an IME composition (picking a kanji or a pinyin
	 * candidate) belongs to the input method, and confirming on it would add
	 * the marker with the half-composed name. Chromium, which runs Obsidian on
	 * the desktop and on Android, marks that keydown isComposing, and the
	 * handler declines it. Whether Obsidian's keymap filters composition
	 * itself is not part of its documented API, so the handler does not rely
	 * on it. Safari, which runs Obsidian on iOS, ends the composition before
	 * the keydown and reports isComposing false, so there the Enter that picks
	 * a candidate still confirms, as it did before this handler existed; the
	 * only sign Safari gives is the deprecated keyCode 229, which this
	 * codebase does not use.
	 * @param evt - The keydown the scope matched
	 * @returns False to have Obsidian prevent the default, true to decline
	 */
	private confirmOnEnter(evt: KeyboardEvent): boolean {
		if (evt.target !== this.inputEl || evt.isComposing) {
			return true;
		}
		this.confirm();
		return false;
	}

	/**
	 * Builds the modal contents: a compact kind toggle and a full-width
	 * name field over a standard button row.
	 */
	override onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('aar-marker-modal');
		this.setDialogTitle('Add marker');

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

		this.renderActions(
			{
				text: 'Add',
				cta: true,
				onClick: () => {
					this.confirm();
				},
			},
			{
				text: 'Cancel',
				onClick: () => {
					this.close();
				},
			},
		);

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
	override onClose(): void {
		if (!this.committed) {
			this.handle.cancel();
		}
		this.contentEl.empty();
	}
}
