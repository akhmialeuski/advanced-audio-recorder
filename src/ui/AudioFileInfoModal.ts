/**
 * Modal for displaying audio file information.
 * @module ui/AudioFileInfoModal
 */

import type { App } from 'obsidian';
import { PluginModal } from './PluginModal';
import type { AudioFileInfo } from '../utils/AudioFileAnalyzer';

/** Duration in milliseconds to show the "Copied!" confirmation. */
const COPY_CONFIRM_MS = 2000;

/**
 * Modal that displays detailed information about an audio file.
 * Includes a "Copy as Markdown" button with transient confirmation feedback.
 */
export class AudioFileInfoModal extends PluginModal {
	private readonly info: AudioFileInfo;

	/**
	 * Creates a new AudioFileInfoModal.
	 * @param app - The Obsidian App instance.
	 * @param info - Audio file information to display.
	 */
	constructor(app: App, info: AudioFileInfo) {
		super(app);
		this.info = info;
	}

	/**
	 * Renders the modal content.
	 */
	override onOpen(): void {
		const { contentEl } = this;

		this.setDialogTitle('Audio file info');

		// Content definition matching the required Markdown output
		const markdownLines = [
			`- **File Name:** \`${this.info.fileName}\``,
			`- **File Size:** \`${this.info.fileSize}\``,
			`- **Duration:** \`${this.info.duration}\``,
			`- **Container Format:** \`${this.info.containerFormat}\``,
			`- **Audio Codec:** \`${this.info.audioCodec}\``,
			`- **Bitrate:** \`${this.info.bitrate}\``,
			`- **Sample Rate:** \`${this.info.sampleRate}\``,
			`- **Channels:** \`${this.info.channels}\``,
		];
		const markdownOutput = markdownLines.join('\n');

		this.renderActions({
			text: 'Copy as Markdown',
			cta: true,
			ref: (button) => {
				button.onClick(() => {
					void navigator.clipboard
						.writeText(markdownOutput)
						.then(() => {
							button.setButtonText('Copied!');
							button.buttonEl.addClass('aar-audio-info-copied');
							window.setTimeout(() => {
								button.setButtonText('Copy as Markdown');
								button.buttonEl.removeClass(
									'aar-audio-info-copied',
								);
							}, COPY_CONFIRM_MS);
						});
				});
			},
			onClick: () => {
				/* the ref above owns the copy handler and its feedback */
			},
		});

		// Render the readable list in HTML for the user interface
		const listElement = contentEl.createEl('ul', {
			cls: 'aar-audio-info-list',
		});

		const addListItem = (label: string, value: string) => {
			const li = listElement.createEl('li');
			const b = li.createEl('strong');
			b.setText(label + ': ');
			const code = li.createEl('code');
			code.setText(value);
		};

		addListItem('File Name', this.info.fileName);
		addListItem('File Size', this.info.fileSize);
		addListItem('Duration', this.info.duration);
		addListItem('Container Format', this.info.containerFormat);
		addListItem('Audio Codec', this.info.audioCodec);
		addListItem('Bitrate', this.info.bitrate);
		addListItem('Sample Rate', this.info.sampleRate);
		addListItem('Channels', this.info.channels);
	}

	/**
	 * Cleans up modal content on close.
	 */
}
