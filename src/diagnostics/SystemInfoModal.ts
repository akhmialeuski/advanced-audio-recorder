/**
 * Modal for displaying system diagnostics information.
 * @module diagnostics/SystemInfoModal
 */

import { App, Modal, Setting } from 'obsidian';
import type { DiagnosticsData } from './SystemDiagnostics';

/** Duration in milliseconds to show the "Copied!" confirmation. */
const COPY_CONFIRM_MS = 2000;

/**
 * Modal that displays a formatted JSON snapshot of system diagnostics.
 * Includes a "Copy to clipboard" button with transient confirmation feedback.
 */
export class SystemInfoModal extends Modal {
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
	onOpen(): void {
		const { contentEl } = this;

		new Setting(contentEl).setName('System diagnostics').setHeading();

		const json = JSON.stringify(this.data, null, 2);

		const copyButton = contentEl.createEl('button', {
			text: 'Copy to clipboard',
			cls: 'mod-cta',
		});

		copyButton.addEventListener('click', () => {
			void navigator.clipboard.writeText(json).then(() => {
				copyButton.setText('Copied!');
				copyButton.addClass('aar-system-info-copied');
				setTimeout(() => {
					copyButton.setText('Copy to clipboard');
					copyButton.removeClass('aar-system-info-copied');
				}, COPY_CONFIRM_MS);
			});
		});

		const pre = contentEl.createEl('pre', { cls: 'aar-system-info-json' });
		pre.setText(json);
	}

	/**
	 * Cleans up modal content on close.
	 */
	onClose(): void {
		this.contentEl.empty();
	}
}
