/**
 * Status bar component for displaying recording status.
 * @module ui/StatusBar
 */

import { RecordingStatus } from '../types';

/**
 * Updates the status bar element based on recording status.
 * Uses Obsidian's extended HTMLElement methods.
 * @param statusBarItem - The status bar HTML element
 * @param status - Current recording status
 */
export function updateStatusBar(
	statusBarItem: HTMLElement | null,
	status: RecordingStatus,
): void {
	if (!statusBarItem) {
		return;
	}

	switch (status) {
		case RecordingStatus.Recording:
			statusBarItem.textContent = 'Recording...';
			statusBarItem.classList.add('is-recording');
			break;
		case RecordingStatus.Paused:
			statusBarItem.textContent = 'Recording paused';
			statusBarItem.classList.add('is-recording');
			break;
		case RecordingStatus.Idle:
		default:
			statusBarItem.textContent = '';
			statusBarItem.classList.remove('is-recording');
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
