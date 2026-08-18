/**
 * Unit tests for RibbonIcon module.
 * Tests the ribbon icon state changes during recording.
 * @module tests/unit/RibbonIcon.test
 */

import { updateRibbonIcon, initializeRibbonIcon } from 'src/ui/RibbonIcon';
import { RecordingStatus } from 'src/types';

describe('RibbonIcon', () => {
	let ribbonElement: HTMLElement;

	beforeEach(() => {
		ribbonElement = document.createElement('div');
		ribbonElement.className = 'side-dock-ribbon-action';
	});

	describe('updateRibbonIcon', () => {
		it('should handle null element gracefully', () => {
			expect(() => {
				updateRibbonIcon(null, RecordingStatus.Recording);
			}).not.toThrow();
		});

		it('should change icon to mic and add is-recording class when recording', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Recording);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('should change icon to mic and add is-recording class when paused', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Paused);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('should change icon to microphone and remove is-recording class when idle', () => {
			// First set to recording
			ribbonElement.classList.add('is-recording');
			ribbonElement.setAttribute('data-icon', 'mic');

			updateRibbonIcon(ribbonElement, RecordingStatus.Idle);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});

		it('should change icon to save and add is-saving class when saving', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Saving);

			expect(ribbonElement.getAttribute('data-icon')).toBe('save');
			expect(ribbonElement.classList.contains('is-saving')).toBe(true);
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});

		it('should remove is-saving class when transitioning from saving to idle', () => {
			ribbonElement.classList.add('is-saving');
			ribbonElement.setAttribute('data-icon', 'save');

			updateRibbonIcon(ribbonElement, RecordingStatus.Idle);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-saving')).toBe(false);
		});

		it('should handle default case same as idle', () => {
			ribbonElement.classList.add('is-recording');

			// Force an unknown status value to test default case
			updateRibbonIcon(ribbonElement, 'unknown' as RecordingStatus);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});
	});

	describe('initializeRibbonIcon', () => {
		it('should handle null element gracefully', () => {
			expect(() => {
				initializeRibbonIcon(null);
			}).not.toThrow();
		});

		it('should set ribbon icon to idle state', () => {
			ribbonElement.classList.add('is-recording');
			ribbonElement.setAttribute('data-icon', 'mic');

			initializeRibbonIcon(ribbonElement);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});
	});
});
