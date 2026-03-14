/**
 * Status bar component for displaying recording status.
 * @module ui/StatusBar
 */

import { RecordingStatus } from '../types';
import type { SaveProgress } from '../types';

/**
 * Updates the status bar element based on recording status.
 * Uses Obsidian's extended HTMLElement methods.
 * @param statusBarItem - The status bar HTML element
 * @param status - Current recording status
 * @param saveProgress - Optional save progress info for Saving state
 */
export function updateStatusBar(
	statusBarItem: HTMLElement | null,
	status: RecordingStatus,
	saveProgress?: SaveProgress,
): void {
	if (!statusBarItem) {
		return;
	}

	switch (status) {
		case RecordingStatus.Recording:
			statusBarItem.empty();
			statusBarItem.textContent = 'Recording...';
			statusBarItem.classList.add('is-recording');
			statusBarItem.classList.remove('is-saving');
			break;
		case RecordingStatus.Paused:
			statusBarItem.empty();
			statusBarItem.textContent = 'Recording paused';
			statusBarItem.classList.add('is-recording');
			statusBarItem.classList.remove('is-saving');
			break;
		case RecordingStatus.Saving: {
			statusBarItem.empty();
			statusBarItem.classList.remove('is-recording');
			statusBarItem.classList.add('is-saving');

			const text = statusBarItem.createSpan();
			text.textContent = saveProgress?.description ?? 'Saving...';

			const progressContainer = statusBarItem.createDiv({
				cls: 'aar-save-progress',
			});
			const progressBar = progressContainer.createDiv({
				cls: 'aar-save-progress-bar',
			});
			const percent = saveProgress?.percent ?? 0;
			progressBar.setCssProps({
				'--save-progress': `${String(percent)}%`,
			});
			break;
		}
		case RecordingStatus.Idle:
		default:
			statusBarItem.empty();
			statusBarItem.textContent = '';
			statusBarItem.classList.remove('is-recording');
			statusBarItem.classList.remove('is-saving');
			break;
	}
}

/**
 * Creates the initial status bar state.
 * @param statusBarItem - The status bar HTML element
 */
export function initializeStatusBar(statusBarItem: HTMLElement | null): void {
	updateStatusBar(statusBarItem, RecordingStatus.Idle);
}
