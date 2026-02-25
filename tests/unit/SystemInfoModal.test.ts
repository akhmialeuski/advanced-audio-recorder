/** @jest-environment jsdom */
/**
 * Unit tests for SystemInfoModal.
 * @module tests/unit/SystemInfoModal
 */

import { SystemInfoModal } from 'src/diagnostics/SystemInfoModal';
import type { DiagnosticsData } from 'src/diagnostics/SystemDiagnostics';
import { App } from 'obsidian';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(overrides: Partial<DiagnosticsData> = {}): DiagnosticsData {
    return {
        pluginSettings: {
            recordingFormat: 'webm',
            bitrate: 128000,
            sampleRate: 44100,
            saveFolder: '',
            saveNearActiveFile: false,
            activeFileSubfolder: '',
            filePrefix: 'recording',
            enableMultiTrack: false,
            maxTracks: 2,
            outputMode: 'single',
            trackAudioSources: {},
            audioDeviceId: 'dev-1',
            debug: false,
        },
        environment: {
            obsidianVersion: '1.5.0',
            electronVersion: '28.0.0',
            nodeVersion: '20.0.0',
            platform: 'linux',
            arch: 'x64',
            userAgent: 'test-agent',
        },
        audioDevices: [
            { deviceId: 'd1', label: 'Mic', groupId: 'g1', kind: 'audioinput' },
        ],
        audioCapabilities: {
            supportedFormats: ['webm'],
            supportedSampleRates: [44100],
            supportedBitrates: [128000],
            mediaRecorderAvailable: true,
            getUserMediaAvailable: true,
        },
        ...overrides,
    };
}

function makeModal(data: DiagnosticsData = makeData()) {
    const app = new App();
    const modal = new SystemInfoModal(app, data);
    modal.onOpen();
    return modal;
}

// ---------------------------------------------------------------------------
// onOpen
// ---------------------------------------------------------------------------

describe('SystemInfoModal.onOpen', () => {
    it('renders a "Copy to clipboard" button', () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toBe('Copy to clipboard');
    });

    it('renders a pre element with JSON content', () => {
        const data = makeData();
        const modal = makeModal(data);
        const expectedJson = JSON.stringify(data, null, 2);

        const pre = modal.contentEl.querySelector('pre');
        expect(pre).not.toBeNull();
        expect(pre?.textContent).toBe(expectedJson);
    });

    it('pre element has the aar-system-info-json CSS class', () => {
        const modal = makeModal();

        const pre = modal.contentEl.querySelector('pre');
        expect(pre?.classList.contains('aar-system-info-json')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Copy button behaviour
// ---------------------------------------------------------------------------

describe('SystemInfoModal copy button', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        Object.defineProperty(global.navigator, 'clipboard', {
            value: { writeText: jest.fn().mockResolvedValue(undefined) },
            configurable: true,
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('calls clipboard.writeText with formatted JSON on click', async () => {
        const data = makeData();
        const modal = makeModal(data);
        const expectedJson = JSON.stringify(data, null, 2);

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expectedJson);
    });

    it('changes button text to "Copied!" after click', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(btn.textContent).toBe('Copied!');
    });

    it('adds aar-system-info-copied CSS class after click', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(btn.classList.contains('aar-system-info-copied')).toBe(true);
    });

    it('reverts button text back to "Copy to clipboard" after 2 seconds', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        jest.advanceTimersByTime(2000);

        expect(btn.textContent).toBe('Copy to clipboard');
    });

    it('removes aar-system-info-copied CSS class after 2 seconds', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        jest.advanceTimersByTime(2000);

        expect(btn.classList.contains('aar-system-info-copied')).toBe(false);
    });

    it('does not revert button text before 2 seconds have passed', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        jest.advanceTimersByTime(1999);

        expect(btn.textContent).toBe('Copied!');
    });
});

// ---------------------------------------------------------------------------
// onClose
// ---------------------------------------------------------------------------

describe('SystemInfoModal.onClose', () => {
    it('empties contentEl on close', () => {
        const modal = makeModal();

        expect(modal.contentEl.children.length).toBeGreaterThan(0);

        modal.onClose();

        expect(modal.contentEl.children.length).toBe(0);
    });
});
