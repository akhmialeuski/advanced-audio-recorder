/**
 * Unit tests for RibbonIcon module.
 * Tests the ribbon icon state changes during recording.
 * @module tests/unit/RibbonIcon.test
 */

import {
	ICON_QUICK_NOTE,
	QUICK_NOTE_GLYPHS,
	updateRibbonIcon,
	initializeRibbonIcon,
} from 'src/ui/RibbonIcon';
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

		it('shows the microphone and adds is-recording when recording', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Recording);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('shows the microphone and adds is-recording when paused', () => {
			updateRibbonIcon(ribbonElement, RecordingStatus.Paused);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
			expect(ribbonElement.classList.contains('is-recording')).toBe(true);
		});

		it('drops is-recording and keeps the microphone when idle', () => {
			// First set to recording
			ribbonElement.classList.add('is-recording');
			ribbonElement.setAttribute('data-icon', 'mic-vocal');

			updateRibbonIcon(ribbonElement, RecordingStatus.Idle);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});

		// An interrupted session is finalizing too, so the icon says the same
		// thing; what makes it different is stated where there is room for it.
		it.each([
			{
				name: 'a stop the user asked for',
				status: RecordingStatus.Saving,
			},
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

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
			expect(ribbonElement.classList.contains('is-saving')).toBe(false);
		});

		it.each([
			RecordingStatus.Idle,
			RecordingStatus.Recording,
			RecordingStatus.Saving,
		])(
			'keeps the quick note glyph while %s, since a dictation saves nothing',
			(status) => {
				updateRibbonIcon(ribbonElement, status, QUICK_NOTE_GLYPHS);

				expect(ribbonElement.getAttribute('data-icon')).toBe(
					ICON_QUICK_NOTE,
				);
				expect(ribbonElement.classList.contains('is-saving')).toBe(
					status === RecordingStatus.Saving,
				);
			},
		);

		it('handles default case same as idle', () => {
			ribbonElement.classList.add('is-recording');

			// Force an unknown status value to test default case
			updateRibbonIcon(ribbonElement, 'unknown' as RecordingStatus);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
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
			ribbonElement.setAttribute('data-icon', 'mic-vocal');

			initializeRibbonIcon(ribbonElement);

			expect(ribbonElement.getAttribute('data-icon')).toBe('mic-vocal');
			expect(ribbonElement.classList.contains('is-recording')).toBe(
				false,
			);
		});
	});
});
