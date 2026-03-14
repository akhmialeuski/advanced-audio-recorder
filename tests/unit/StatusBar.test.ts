/**
 * Unit tests for StatusBar module.
 * Tests the status bar state changes during recording and saving.
 * @module tests/unit/StatusBar.test
 */
/** @jest-environment jsdom */

import { updateStatusBar, initializeStatusBar } from '../../src/ui/StatusBar';
import { RecordingStatus } from '../../src/types';
import type { RecordingControls } from '../../src/types';

jest.mock('obsidian', () => ({
	setIcon: jest.fn(),
}));

/**
 * Polyfill Obsidian's HTMLElement extensions for jsdom.
 */
function addObsidianElementMethods(el: HTMLElement): HTMLElement {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for patching Obsidian DOM extensions
	const obsEl = el as any;
	obsEl.empty = function () {
		while (this.firstChild) {
			this.removeChild(this.firstChild);
		}
	};
	obsEl.createSpan = function (opts?: { cls?: string }) {
		const span = document.createElement('span');
		if (opts?.cls) {
			span.className = opts.cls;
		}
		addObsidianElementMethods(span);
		this.appendChild(span);
		return span;
	};
	obsEl.createDiv = function (opts?: { cls?: string }) {
		const div = document.createElement('div');
		if (opts?.cls) {
			div.className = opts.cls;
		}
		addObsidianElementMethods(div);
		this.appendChild(div);
		return div;
	};
	obsEl.setCssProps = function (props: Record<string, string>) {
		for (const [key, value] of Object.entries(props)) {
			this.style.setProperty(key, value);
		}
	};
	return el;
}

describe('StatusBar', () => {
	let statusBarItem: HTMLElement;

	beforeEach(() => {
		statusBarItem = addObsidianElementMethods(
			document.createElement('div'),
		);
	});

	describe('updateStatusBar', () => {
		it('should handle null element gracefully', () => {
			expect(() => {
				updateStatusBar(null, RecordingStatus.Recording);
			}).not.toThrow();
		});

		it('should show "Recording..." and add is-recording class when recording', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Recording);

			expect(statusBarItem.textContent).toContain('Recording...');
			expect(statusBarItem.classList.contains('is-recording')).toBe(true);
			expect(statusBarItem.classList.contains('is-saving')).toBe(false);
		});

		it('should show "Recording paused" when paused', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Paused);

			expect(statusBarItem.textContent).toContain('Recording paused');
			expect(statusBarItem.classList.contains('is-recording')).toBe(true);
		});

		it('should clear text and remove classes when idle', () => {
			statusBarItem.classList.add('is-recording');
			statusBarItem.classList.add('is-saving');
			statusBarItem.textContent = 'Something';

			updateStatusBar(statusBarItem, RecordingStatus.Idle);

			expect(statusBarItem.textContent).toBe('');
			expect(statusBarItem.classList.contains('is-recording')).toBe(
				false,
			);
			expect(statusBarItem.classList.contains('is-saving')).toBe(false);
		});

		it('should show saving state with progress bar', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 40,
				description: 'Assembling audio...',
			});

			expect(statusBarItem.classList.contains('is-saving')).toBe(true);
			expect(statusBarItem.classList.contains('is-recording')).toBe(
				false,
			);

			const text = statusBarItem.querySelector('span');
			expect(text?.textContent).toBe('Assembling audio...');

			const progressBar = statusBarItem.querySelector(
				'.aar-save-progress-bar',
			) as HTMLElement;
			expect(progressBar).not.toBeNull();
			expect(
				progressBar?.style.getPropertyValue('--save-progress'),
			).toBe('40%');
		});

		it('should show default "Saving..." when no progress provided', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving);

			const text = statusBarItem.querySelector('span');
			expect(text?.textContent).toBe('Saving...');

			const progressBar = statusBarItem.querySelector(
				'.aar-save-progress-bar',
			) as HTMLElement;
			expect(
				progressBar?.style.getPropertyValue('--save-progress'),
			).toBe('0%');
		});

		it('should have progress container with correct classes', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 60,
				description: 'Writing file...',
			});

			const container =
				statusBarItem.querySelector('.aar-save-progress');
			expect(container).not.toBeNull();

			const bar = container?.querySelector('.aar-save-progress-bar');
			expect(bar).not.toBeNull();
		});

		it('should remove is-saving when transitioning from saving to idle', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 100,
				description: 'Saved',
			});
			expect(statusBarItem.classList.contains('is-saving')).toBe(true);

			updateStatusBar(statusBarItem, RecordingStatus.Idle);
			expect(statusBarItem.classList.contains('is-saving')).toBe(false);
			expect(statusBarItem.textContent).toBe('');
		});

		it('should clear previous content when transitioning between states', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 50,
				description: 'Assembling...',
			});
			expect(
				statusBarItem.querySelector('.aar-save-progress'),
			).not.toBeNull();

			updateStatusBar(statusBarItem, RecordingStatus.Recording);
			expect(
				statusBarItem.querySelector('.aar-save-progress'),
			).toBeNull();
			expect(statusBarItem.textContent).toContain('Recording...');
		});

		it('should handle default case same as idle', () => {
			statusBarItem.classList.add('is-recording');

			updateStatusBar(statusBarItem, 'unknown' as RecordingStatus);

			expect(statusBarItem.textContent).toBe('');
			expect(statusBarItem.classList.contains('is-recording')).toBe(
				false,
			);
		});
	});

	describe('recording controls', () => {
		it('should render pause and stop buttons when recording with controls', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const container = statusBarItem.querySelector(
				'.aar-recording-controls',
			);
			expect(container).not.toBeNull();

			const label = statusBarItem.querySelector('.aar-recording-label');
			expect(label?.textContent).toBe('Recording...');

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			expect(buttons.length).toBe(2);
		});

		it('should render resume and stop buttons when paused with controls', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: true,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Paused,
				undefined,
				controls,
			);

			const label = statusBarItem.querySelector('.aar-recording-label');
			expect(label?.textContent).toBe('Recording paused');

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			expect(buttons.length).toBe(2);

			// First button should have aria-label "Resume recording"
			expect(buttons[0].getAttribute('aria-label')).toBe(
				'Resume recording',
			);
			expect(buttons[1].getAttribute('aria-label')).toBe(
				'Stop recording',
			);
		});

		it('should call onPauseResume when pause button is clicked', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			expect(buttons[0].getAttribute('aria-label')).toBe(
				'Pause recording',
			);

			buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(controls.onPauseResume).toHaveBeenCalledTimes(1);
		});

		it('should call onStop when stop button is clicked', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(controls.onStop).toHaveBeenCalledTimes(1);
		});

		it('should not render buttons when controls are not provided', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Recording);

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			expect(buttons.length).toBe(0);

			// Should still show recording label in container
			const label = statusBarItem.querySelector('.aar-recording-label');
			expect(label?.textContent).toBe('Recording...');
		});

		it('should set accessible attributes on control buttons', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			for (const button of buttons) {
				expect(button.getAttribute('role')).toBe('button');
				expect(button.getAttribute('tabindex')).toBe('0');
				expect(button.getAttribute('aria-label')).toBeTruthy();
			}
		});

		it('should stop event propagation on button click', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const buttons = statusBarItem.querySelectorAll('.aar-control-btn');
			const event = new MouseEvent('click', { bubbles: true });
			const stopPropSpy = jest.spyOn(event, 'stopPropagation');

			buttons[0].dispatchEvent(event);
			expect(stopPropSpy).toHaveBeenCalled();
		});

		it('should show buttons container with correct class', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			const buttonsContainer = statusBarItem.querySelector(
				'.aar-recording-buttons',
			);
			expect(buttonsContainer).not.toBeNull();
		});

		it('should clear controls when transitioning to idle', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);
			expect(
				statusBarItem.querySelectorAll('.aar-control-btn').length,
			).toBe(2);

			updateStatusBar(statusBarItem, RecordingStatus.Idle);
			expect(
				statusBarItem.querySelectorAll('.aar-control-btn').length,
			).toBe(0);
		});

		it('should clear controls when transitioning to saving', () => {
			const controls: RecordingControls = {
				onPauseResume: jest.fn(),
				onStop: jest.fn(),
				isPaused: false,
			};

			updateStatusBar(
				statusBarItem,
				RecordingStatus.Recording,
				undefined,
				controls,
			);

			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 10,
				description: 'Saving...',
			});

			expect(
				statusBarItem.querySelectorAll('.aar-control-btn').length,
			).toBe(0);
			expect(statusBarItem.classList.contains('is-saving')).toBe(true);
		});
	});

	describe('initializeStatusBar', () => {
		it('should handle null element gracefully', () => {
			expect(() => {
				initializeStatusBar(null);
			}).not.toThrow();
		});

		it('should set status bar to idle state', () => {
			statusBarItem.classList.add('is-recording');
			statusBarItem.textContent = 'Recording...';

			initializeStatusBar(statusBarItem);

			expect(statusBarItem.textContent).toBe('');
			expect(statusBarItem.classList.contains('is-recording')).toBe(
				false,
			);
		});
	});
});
