/**
 * Unit tests for RibbonIcon module.
 * Tests the ribbon icon state changes during recording.
 * @module tests/unit/RibbonIcon.test
 */
/** @jest-environment jsdom */

import { updateRibbonIcon, initializeRibbonIcon } from '../../src/ui/RibbonIcon';
import { RecordingStatus } from '../../src/types';

// Mock the setIcon function from obsidian
jest.mock('obsidian', () => ({
    setIcon: jest.fn((el: HTMLElement, iconName: string) => {
        el.setAttribute('data-icon', iconName);
    }),
}));

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
            expect(ribbonElement.classList.contains('is-recording')).toBe(false);
        });

        it('should handle default case same as idle', () => {
            ribbonElement.classList.add('is-recording');

            // Force an unknown status value to test default case
            updateRibbonIcon(ribbonElement, 'unknown' as RecordingStatus);

            expect(ribbonElement.getAttribute('data-icon')).toBe('microphone');
            expect(ribbonElement.classList.contains('is-recording')).toBe(false);
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
            expect(ribbonElement.classList.contains('is-recording')).toBe(false);
        });
    });
});
