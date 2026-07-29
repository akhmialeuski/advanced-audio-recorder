/**
 * Unit tests for StatusBar module.
 * Tests the status bar state changes during recording and saving.
 * @module tests/unit/StatusBar.test
 */

import {
	updateStatusBar,
	initializeStatusBar,
	renderPlaybackStatusBar,
	renderTranscriptionStatusBar,
} from 'src/ui/StatusBar';
import { at } from '../helpers/assertions';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { RecordingStatus } from 'src/types';
import type { RecordingControls } from 'src/types';

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
	obsEl.createEl = function (
		tag: string,
		opts?: {
			cls?: string;
			text?: string;
			attr?: Record<string, string>;
		},
	) {
		const child = document.createElement(tag);
		if (opts?.cls) {
			child.className = opts.cls;
		}
		if (opts?.text) {
			child.textContent = opts.text;
		}
		for (const [key, value] of Object.entries(opts?.attr ?? {})) {
			child.setAttribute(key, value);
		}
		addObsidianElementMethods(child);
		this.appendChild(child);
		return child;
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
	obsEl.setText = function (text: string) {
		this.textContent = text;
	};
	obsEl.addClass = function (...classes: string[]) {
		this.classList.add(...classes);
	};
	obsEl.toggleClass = function (cls: string, force?: boolean) {
		this.classList.toggle(cls, force);
	};
	return el;
}

/**
 * Builds a complete playback snapshot with jest-backed commands.
 * @param overrides - State fields to replace for a specific assertion
 * @returns Playback state accepted by the status-bar renderer
 */
function makePlaybackState(
	overrides: Partial<PlaybackControlsState> = {},
): PlaybackControlsState {
	return {
		currentTime: 65,
		duration: 222,
		paused: false,
		volume: 0.75,
		muted: false,
		markersEnabled: true,
		onTogglePlay: jest.fn(),
		onStop: jest.fn(),
		onSkip: jest.fn(),
		onToggleMute: jest.fn(),
		onVolumeInput: jest.fn(),
		onAddMarker: jest.fn(),
		...overrides,
	};
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
			expect(progressBar?.style.getPropertyValue('--save-progress')).toBe(
				'40%',
			);
		});

		it('should show default "Saving..." when no progress provided', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving);

			const text = statusBarItem.querySelector('span');
			expect(text?.textContent).toBe('Saving...');

			const progressBar = statusBarItem.querySelector(
				'.aar-save-progress-bar',
			) as HTMLElement;
			expect(progressBar?.style.getPropertyValue('--save-progress')).toBe(
				'0%',
			);
		});

		it('should have progress container with correct classes', () => {
			updateStatusBar(statusBarItem, RecordingStatus.Saving, {
				percent: 60,
				description: 'Writing file...',
			});

			const container = statusBarItem.querySelector('.aar-save-progress');
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

		it('should clear transcription state when transitioning to recording', () => {
			renderTranscriptionStatusBar(
				statusBarItem,
				{
					percent: 50,
					description: 'Transcribing audio...',
				},
				{
					onActivate: jest.fn(),
					activationLabel: 'Restore transcription window',
				},
			);

			updateStatusBar(statusBarItem, RecordingStatus.Recording);

			expect(statusBarItem.classList.contains('is-transcribing')).toBe(
				false,
			);
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

	describe('transcription progress', () => {
		it('should show minimized transcription progress in the status bar', () => {
			renderTranscriptionStatusBar(
				statusBarItem,
				{
					percent: 35,
					description: 'Transcribing chunk 1...',
				},
				{
					onActivate: jest.fn(),
					activationLabel: 'Restore transcription window',
				},
			);

			expect(statusBarItem.classList.contains('is-transcribing')).toBe(
				true,
			);
			expect(statusBarItem.classList.contains('is-recording')).toBe(
				false,
			);
			expect(statusBarItem.classList.contains('is-saving')).toBe(false);
			expect(statusBarItem.textContent).toContain(
				'Transcribing chunk 1...',
			);

			const progressBar = statusBarItem.querySelector(
				'.aar-save-progress-bar',
			) as HTMLElement;
			expect(progressBar).not.toBeNull();
			expect(progressBar.style.getPropertyValue('--save-progress')).toBe(
				'35%',
			);
		});

		it('should restore transcription on a single click', () => {
			const onActivate = jest.fn();
			renderTranscriptionStatusBar(
				statusBarItem,
				{
					percent: 10,
					description: 'Transcribing...',
				},
				{
					onActivate,
					activationLabel: 'Restore transcription window',
				},
			);

			const action = statusBarItem.querySelector(
				'.aar-status-progress-actionable',
			);
			action?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onActivate).toHaveBeenCalledTimes(1);
		});

		it('should not restore transcription on a double click only', () => {
			const onActivate = jest.fn();
			renderTranscriptionStatusBar(
				statusBarItem,
				{
					percent: 10,
					description: 'Transcribing...',
				},
				{
					onActivate,
					activationLabel: 'Restore transcription window',
				},
			);

			const action = statusBarItem.querySelector(
				'.aar-status-progress-actionable',
			);
			// A bare dblclick event no longer triggers the restore; only the
			// click events a real double click also fires would.
			action?.dispatchEvent(
				new MouseEvent('dblclick', { bubbles: true }),
			);

			expect(onActivate).not.toHaveBeenCalled();
		});

		it('should restore transcription from keyboard activation', () => {
			const onActivate = jest.fn();
			renderTranscriptionStatusBar(
				statusBarItem,
				{
					percent: 10,
					description: 'Transcribing...',
				},
				{
					onActivate,
					activationLabel: 'Restore transcription window',
				},
			);

			const action = statusBarItem.querySelector(
				'.aar-status-progress-actionable',
			);
			action?.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
				}),
			);
			action?.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: ' ',
					bubbles: true,
				}),
			);

			expect(onActivate).toHaveBeenCalledTimes(2);
		});
	});

	describe('playback controls', () => {
		it('should handle a missing status bar element', () => {
			expect(() => {
				renderPlaybackStatusBar(null, makePlaybackState());
			}).not.toThrow();
		});

		it('should render transport, volume, markers, chapters, and time without speed controls', () => {
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());

			expect(statusBarItem.classList.contains('is-playback')).toBe(true);
			expect(
				statusBarItem.querySelector('[aria-label="Back 10s"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('[aria-label="Pause playback"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('[aria-label="Stop playback"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('[aria-label="Forward 10s"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('[aria-label="Mute / unmute"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('[aria-label="Volume"]'),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector(
					'[aria-label="Add marker at current position"]',
				),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector(
					'[aria-label="Add chapter at current position"]',
				),
			).not.toBeNull();
			expect(
				statusBarItem.querySelector('.aar-playback-time')?.textContent,
			).toBe('1:05 / 3:42');
			expect(
				statusBarItem.querySelector('[aria-label="Playback speed"]'),
			).toBeNull();
			expect(statusBarItem.querySelector('.aar-player-speed')).toBeNull();
		});

		it('should dispatch every playback command from mouse and volume input', () => {
			const state = makePlaybackState();
			renderPlaybackStatusBar(statusBarItem, state);

			statusBarItem
				.querySelector<HTMLElement>('[aria-label="Back 10s"]')
				?.click();
			statusBarItem
				.querySelector<HTMLElement>('[aria-label="Pause playback"]')
				?.click();
			statusBarItem
				.querySelector<HTMLElement>('[aria-label="Stop playback"]')
				?.click();
			statusBarItem
				.querySelector<HTMLElement>('[aria-label="Forward 10s"]')
				?.click();
			statusBarItem
				.querySelector<HTMLElement>('[aria-label="Mute / unmute"]')
				?.click();
			statusBarItem
				.querySelector<HTMLElement>(
					'[aria-label="Add marker at current position"]',
				)
				?.click();
			statusBarItem
				.querySelector<HTMLElement>(
					'[aria-label="Add chapter at current position"]',
				)
				?.click();
			const volume = statusBarItem.querySelector<HTMLInputElement>(
				'.aar-playback-volume',
			);
			if (!volume) {
				throw new Error('Expected playback volume input');
			}
			volume.value = '0.4';
			volume.dispatchEvent(new Event('input'));

			expect(state.onSkip).toHaveBeenNthCalledWith(1, -10);
			expect(state.onSkip).toHaveBeenNthCalledWith(2, 10);
			expect(state.onTogglePlay).toHaveBeenCalledTimes(1);
			expect(state.onStop).toHaveBeenCalledTimes(1);
			expect(state.onToggleMute).toHaveBeenCalledTimes(1);
			expect(state.onVolumeInput).toHaveBeenCalledWith(0.4);
			expect(state.onAddMarker).toHaveBeenNthCalledWith(1, 'bookmark');
			expect(state.onAddMarker).toHaveBeenNthCalledWith(2, 'chapter');
		});

		it('should keep the controls DOM while updating pause, mute, markers, volume, and time', () => {
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());
			const controls = statusBarItem.querySelector(
				'.aar-playback-controls',
			);

			renderPlaybackStatusBar(
				statusBarItem,
				makePlaybackState({
					currentTime: 5,
					duration: 0,
					paused: true,
					muted: true,
					volume: 0.2,
					markersEnabled: false,
				}),
			);

			expect(statusBarItem.querySelector('.aar-playback-controls')).toBe(
				controls,
			);
			expect(
				statusBarItem.querySelector('[aria-label="Play audio"]'),
			).not.toBeNull();
			expect(
				statusBarItem
					.querySelector('.aar-playback-mute')
					?.classList.contains('is-active'),
			).toBe(true);
			expect(
				statusBarItem.querySelector<HTMLInputElement>(
					'.aar-playback-volume',
				)?.value,
			).toBe('0.2');
			expect(
				statusBarItem.querySelector<HTMLElement>(
					'.aar-playback-marker-controls',
				)?.hidden,
			).toBe(true);
			expect(
				statusBarItem.querySelector('.aar-playback-time')?.textContent,
			).toBe('0:05 / 0:00');
		});

		it('should preserve a focused volume input during playback updates', () => {
			document.body.appendChild(statusBarItem);
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());
			const volume = statusBarItem.querySelector<HTMLInputElement>(
				'.aar-playback-volume',
			);
			if (!volume) {
				throw new Error('Expected playback volume input');
			}
			volume.value = '0.3';
			volume.focus();

			renderPlaybackStatusBar(
				statusBarItem,
				makePlaybackState({ volume: 0.9 }),
			);

			expect(volume.value).toBe('0.3');
			statusBarItem.remove();
		});

		it('should tolerate controls removed by an external status-bar refresh', () => {
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());
			const controls = statusBarItem.querySelector<HTMLElement>(
				'.aar-playback-controls',
			);
			controls?.querySelector('.aar-playback-toggle')?.remove();
			controls?.querySelector('.aar-playback-mute')?.remove();
			controls?.querySelector('.aar-playback-volume')?.remove();
			controls?.querySelector('.aar-playback-marker-controls')?.remove();
			controls?.querySelector('.aar-playback-time')?.remove();

			expect(() => {
				renderPlaybackStatusBar(statusBarItem, makePlaybackState());
			}).not.toThrow();
		});

		it('should activate transport controls with Enter and Space only', () => {
			const state = makePlaybackState();
			renderPlaybackStatusBar(statusBarItem, state);
			const toggle = statusBarItem.querySelector<HTMLElement>(
				'.aar-playback-toggle',
			);

			toggle?.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter' }),
			);
			toggle?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
			toggle?.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight' }),
			);

			expect(state.onTogglePlay).toHaveBeenCalledTimes(2);
		});

		it('should clear playback controls when recording takes precedence', () => {
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());

			updateStatusBar(statusBarItem, RecordingStatus.Recording);

			expect(
				statusBarItem.querySelector('.aar-playback-controls'),
			).toBeNull();
			expect(statusBarItem.classList.contains('is-playback')).toBe(false);
			expect(statusBarItem.textContent).toContain('Recording...');
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
			expect(at(buttons, 0).getAttribute('aria-label')).toBe(
				'Resume recording',
			);
			expect(at(buttons, 1).getAttribute('aria-label')).toBe(
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
			expect(at(buttons, 0).getAttribute('aria-label')).toBe(
				'Pause recording',
			);

			at(buttons, 0).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);
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
			at(buttons, 1).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);
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

			at(buttons, 0).dispatchEvent(event);
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
