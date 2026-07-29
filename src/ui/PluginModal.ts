/**
 * The base every plugin dialog extends, so the twelve of them stop being
 * twelve independent takes on the same window.
 *
 * Before this, dialogs split three ways: some titled themselves with a heading
 * Setting and some with `setTitle`, some built their action row with
 * `Setting.addButton` and some with raw `createEl('button')` inside a
 * `modal-button-container`, some emptied `contentEl` on close and some did not,
 * the "Source: <file>" line appeared with three different classes, and the
 * "a job is running" flag had seven names across seven hand-written guards.
 *
 * Subclasses now describe what is theirs - the fields, the work, the copy - and
 * inherit the frame: title, source line, empty state, action row, the busy
 * guard that survives a throw, and teardown.
 * @module ui/PluginModal
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App, ButtonComponent, TFile } from 'obsidian';

/** One button in a dialog's action row. */
export interface DialogAction {
	/** Button label. */
	text: string;
	/** Render as the primary (call-to-action) button. */
	cta?: boolean;
	/** Render as a destructive button (e.g. "Replace existing chapters"). */
	destructive?: boolean;
	/** Start out disabled. */
	disabled?: boolean;
	/** Invoked on click. A rejected promise is reported, never swallowed. */
	onClick(): void | Promise<void>;
	/** Receives the built component, so a caller can toggle it later. */
	ref?(button: ButtonComponent): void;
}

/**
 * Shared frame for the plugin's dialogs. Extends Obsidian's Modal rather than
 * replacing it, so anything not covered here is still plain Modal usage.
 */
export abstract class PluginModal extends Modal {
	/**
	 * Whether a job started from this dialog is in flight. One flag with one
	 * name, guarded by {@link runExclusive}, replacing the per-dialog
	 * `running`/`processing`/`isConverting`/`isSplitting`/`generating`/
	 * `applying`/`isRunning` booleans that each had to be reset by hand on every
	 * exit path.
	 */
	protected busy = false;

	constructor(app: App) {
		super(app);
	}

	/**
	 * Sets the dialog's title. Uses Obsidian's own title bar rather than a
	 * heading row inside the body, so every dialog is titled the same way.
	 * @param title - Dialog title in sentence case
	 */
	protected setDialogTitle(title: string): void {
		this.setTitle(title);
	}

	/**
	 * Renders the "Source: <file name>" line every file-scoped dialog shows.
	 * @param file - The file the dialog acts on
	 */
	protected renderSource(file: TFile): void {
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${file.name}`,
		});
	}

	/**
	 * Renders an explanation plus a lone Close button, for the case where the
	 * dialog has nothing to offer (no transcript to chapter, no stored speakers
	 * to rename, an unreadable sidecar).
	 * @param message - Why there is nothing to do
	 */
	protected renderEmptyState(message: string): void {
		this.contentEl.createEl('p', { text: message });
		this.renderActions({
			text: 'Close',
			onClick: () => {
				this.close();
			},
		});
	}

	/**
	 * Renders the dialog's action row. One builder for every dialog, so the
	 * buttons are laid out and styled identically whether or not the dialog
	 * previously used Setting.addButton.
	 * @param actions - The buttons, primary action first
	 */
	protected renderActions(...actions: DialogAction[]): void {
		const row = new Setting(this.contentEl);
		row.settingEl.addClass('aar-modal-actions');
		for (const action of actions) {
			row.addButton((button) => {
				button.setButtonText(action.text);
				if (action.cta) {
					button.setCta();
				}
				if (action.destructive) {
					// The class both setWarning (deprecated) and setDestructive
					// (Obsidian 1.13+) apply. Setting it directly is the one form
					// that works on every version down to the plugin's declared
					// minAppVersion without calling a deprecated API.
					button.buttonEl.addClass('mod-warning');
				}
				if (action.disabled) {
					button.setDisabled(true);
				}
				button.onClick(() => {
					void this.report(action.onClick());
				});
				action.ref?.(button);
			});
		}
	}

	/**
	 * Runs a job at most once at a time, clearing the busy flag on every exit
	 * path including a throw. Every dialog previously wrote this guard by hand,
	 * and a throw between the flag and its reset left the dialog permanently
	 * inert.
	 * @param job - The work to run
	 * @returns True when the job ran, false when one was already in flight
	 */
	protected async runExclusive(job: () => Promise<void>): Promise<boolean> {
		if (this.busy) {
			return false;
		}
		this.busy = true;
		try {
			await job();
			return true;
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Surfaces a rejected click handler as a Notice instead of an unhandled
	 * rejection, so a failure in a dialog action is always visible.
	 * @param result - The handler's return value
	 */
	private async report(result: void | Promise<void>): Promise<void> {
		try {
			await result;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(message);
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
