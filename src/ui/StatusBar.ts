/**
 * Status bar component for displaying recording status and controls.
 * @module ui/StatusBar
 */

import { setIcon } from 'obsidian';
import { RecordingStatus } from '../types';
import type { SaveProgress, RecordingControls } from '../types';

/**
 * Updates the status bar element based on recording status.
 * Uses Obsidian's extended HTMLElement methods.
 * @param statusBarItem - The status bar HTML element
 * @param status - Current recording status
 * @param saveProgress - Optional save progress info for Saving state
 * @param controls - Optional recording control callbacks for interactive buttons
 */
export function updateStatusBar(
	statusBarItem: HTMLElement | null,
	status: RecordingStatus,
	saveProgress?: SaveProgress,
	controls?: RecordingControls,
): void {
	if (!statusBarItem) {
		return;
	}

	switch (status) {
		case RecordingStatus.Recording:
			renderRecordingState(statusBarItem, 'Recording...', controls);
			break;
		case RecordingStatus.Paused:
			renderRecordingState(statusBarItem, 'Recording paused', controls);
			break;
		case RecordingStatus.Saving:
			renderSavingState(statusBarItem, saveProgress);
			break;
		case RecordingStatus.Idle:
		default:
			renderIdleState(statusBarItem);
			break;
	}
}

/**
 * Renders the recording or paused state with control buttons.
 * @param el - The status bar HTML element
 * @param label - Display text for the current state
 * @param controls - Optional recording control callbacks
 */
function renderRecordingState(
	el: HTMLElement,
	label: string,
	controls?: RecordingControls,
): void {
	el.empty();
	el.classList.add('is-recording');
	el.classList.remove('is-saving');

	const container = el.createDiv({ cls: 'aar-recording-controls' });
	const text = container.createSpan({ cls: 'aar-recording-label' });
	text.textContent = label;

	if (controls) {
		const buttons = container.createSpan({
			cls: 'aar-recording-buttons',
		});
		createControlButton(
			buttons,
			controls.isPaused ? 'play' : 'pause',
			controls.isPaused ? 'Resume recording' : 'Pause recording',
			controls.onPauseResume,
		);
		createControlButton(
			buttons,
			'square',
			'Stop recording',
			controls.onStop,
		);
	}
}

/**
 * Creates a clickable control button with an icon in the status bar.
 * @param parent - Parent element to append the button to
 * @param icon - Obsidian icon name
 * @param ariaLabel - Accessible label for the button
 * @param onClick - Click handler
 */
function createControlButton(
	parent: HTMLElement,
	icon: string,
	ariaLabel: string,
	onClick: () => void,
): void {
	const button = parent.createSpan({ cls: 'aar-control-btn' });
	button.setAttribute('aria-label', ariaLabel);
	button.setAttribute('role', 'button');
	button.tabIndex = 0;
	setIcon(button, icon);
	button.addEventListener('click', (e: MouseEvent) => {
		e.stopPropagation();
		onClick();
	});
}

/**
 * Renders the saving state with progress bar.
 * @param el - The status bar HTML element
 * @param saveProgress - Optional save progress info
 */
function renderSavingState(el: HTMLElement, saveProgress?: SaveProgress): void {
	el.empty();
	el.classList.remove('is-recording');
	el.classList.add('is-saving');

	const text = el.createSpan();
	text.textContent = saveProgress?.description ?? 'Saving...';

	const progressContainer = el.createDiv({
		cls: 'aar-save-progress',
	});
	const progressBar = progressContainer.createDiv({
		cls: 'aar-save-progress-bar',
	});
	const percent = saveProgress?.percent ?? 0;
	progressBar.setCssProps({
		'--save-progress': `${String(percent)}%`,
	});
}

/**
 * Renders the idle state (empty status bar).
 * @param el - The status bar HTML element
 */
function renderIdleState(el: HTMLElement): void {
	el.empty();
	el.textContent = '';
	el.classList.remove('is-recording');
	el.classList.remove('is-saving');
}

/**
 * Creates the initial status bar state.
 * @param statusBarItem - The status bar HTML element
 */
export function initializeStatusBar(statusBarItem: HTMLElement | null): void {
	updateStatusBar(statusBarItem, RecordingStatus.Idle);
}
