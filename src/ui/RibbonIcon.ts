/**
 * Ribbon icon component for displaying recording status.
 * @module ui/RibbonIcon
 */

import { setIcon } from 'obsidian';
import { RecordingStatus } from '../types';

/** Icon name for idle state */
const ICON_IDLE = 'microphone';
/** Icon name for recording state */
const ICON_RECORDING = 'mic';

/**
 * Updates the ribbon icon element based on recording status.
 * Changes the icon and toggles the recording CSS class.
 * @param ribbonIconEl - The ribbon icon HTML element
 * @param status - Current recording status
 */
export function updateRibbonIcon(
    ribbonIconEl: HTMLElement | null,
    status: RecordingStatus,
): void {
    if (!ribbonIconEl) {
        return;
    }

    switch (status) {
        case RecordingStatus.Recording:
            setIcon(ribbonIconEl, ICON_RECORDING);
            ribbonIconEl.classList.add('is-recording');
            break;
        case RecordingStatus.Paused:
            setIcon(ribbonIconEl, ICON_RECORDING);
            ribbonIconEl.classList.add('is-recording');
            break;
        case RecordingStatus.Idle:
        default:
            setIcon(ribbonIconEl, ICON_IDLE);
            ribbonIconEl.classList.remove('is-recording');
            break;
    }
}

/**
 * Initializes the ribbon icon to idle state.
 * @param ribbonIconEl - The ribbon icon HTML element
 */
export function initializeRibbonIcon(ribbonIconEl: HTMLElement | null): void {
    updateRibbonIcon(ribbonIconEl, RecordingStatus.Idle);
}
