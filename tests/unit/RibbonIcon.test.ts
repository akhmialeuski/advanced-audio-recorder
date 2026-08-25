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
		it('handles null element gracefully', () => {
			expect(() => {
				updateRibbonIcon(null, RecordingStatus.Recording);
			}).not.toThrow();
		});

		it('changes icon to mic and add is-recording class when recording', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Recording);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('changes icon to mic and add is-recording class when paused', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Paused);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('changes icon to microphone and remove is-recording class when idle', () => {
			// First set to recording
			ribbonElement.classList.add('is-recording');
			ribbonElement.setAttribute('data-icon', 'mic');

			updateRibbonIcon(ribbonElement, RecordingStatus.Idle);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});

		// An interrupted session is finalizing too, so the icon says the same
		// thing; what makes it different is stated where there is room for it.
		it.each([
			{ name: 'a stop the user asked for', status: RecordingStatus.Saving },
			{
				name: 'a session whose input was lost',
				status: RecordingStatus.Interrupted,
			},
		])('shows the saving icon for $name', ({ status }) => {
			updateRibbonIcon(ribbonElement, status);

			expect(ribbonElement.getAttribute('data-icon')).toBe('save');
			expect(ribbonElement.classList.contains('is-saving')).toBe(true);
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});

		it('removes is-saving class when transitioning from saving to idle', () => {
			ribbonElement.classList.add('is-saving');
			ribbonElement.setAttribute('data-icon', 'save');

			updateRibbonIcon(ribbonElement, RecordingStatus.Idle);

			expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
			expect(ribbonElement.classList.contains('is-saving')).toBe(false);
		});

		it('handles default case same as idle', () => {
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
		it('handles null element gracefully', () => {
			expect(() => {
				initializeRibbonIcon(null);
			}).not.toThrow();
		});

		it('sets ribbon icon to idle state', () => {
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
