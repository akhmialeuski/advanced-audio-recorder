/**
 * Modal for displaying system diagnostics information.
 * @module diagnostics/SystemInfoModal
 */

import type { App } from 'obsidian';
import { PluginModal } from '../ui/PluginModal';
import type { DiagnosticsData } from './SystemDiagnostics';

/** Duration in milliseconds to show the "Copied!" confirmation. */
const COPY_CONFIRM_MS = 2000;

/**
 * Modal that displays a formatted JSON snapshot of system diagnostics.
 * Includes a "Copy to clipboard" button with transient confirmation feedback.
 */
export class SystemInfoModal extends PluginModal {
	private readonly data: DiagnosticsData;

	/**
	 * Creates a new SystemInfoModal.
	 * @param app - The Obsidian App instance
	 * @param data - Diagnostics data to display
	 */
	constructor(app: App, data: DiagnosticsData) {
		super(app);
		this.data = data;
	}

	/**
	 * Renders the modal content.
	 */
	override onOpen(): void {
		const { contentEl } = this;
		this.setDialogTitle('System diagnostics');

		const json = JSON.stringify(this.data, null, 2);

		this.renderActions({
			text: 'Copy to clipboard',
			cta: true,
			ref: (button) => {
				button.onClick(() => {
					void navigator.clipboard.writeText(json).then(() => {
						button.setButtonText('Copied!');
						button.buttonEl.addClass('aar-system-info-copied');
						window.setTimeout(() => {
							button.setButtonText('Copy to clipboard');
							button.buttonEl.removeClass(
								'aar-system-info-copied',
							);
						}, COPY_CONFIRM_MS);
					});
				});
			},
			onClick: () => {
				/* the ref above owns the copy handler and its feedback */
			},
		});

		const pre = contentEl.createEl('pre', { cls: 'aar-system-info-json' });
		pre.setText(json);
	}
}
