/** @jest-environment jsdom */
/**
 * Unit tests for AudioFileInfoModal.
 * @module tests/unit/AudioFileInfoModal
 */

import { AudioFileInfoModal } from '../../src/ui/AudioFileInfoModal';
import type { AudioFileInfo } from '../../src/utils/AudioFileAnalyzer';
import { App } from 'obsidian';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(overrides: Partial<AudioFileInfo> = {}): AudioFileInfo {
    return {
        fileName: 'test.webm',
        filePath: 'path/to/test.webm',
        fileSize: '1.5 MB',
        duration: '00:01:30',
        containerFormat: 'audio/webm',
        audioCodec: 'opus',
        bitrate: '128 kbps',
        sampleRate: '48000 Hz',
        channels: '2 (Stereo)',
        ...overrides,
    };
}

function makeModal(info: AudioFileInfo = makeData()) {
    const app = new App();
    const modal = new AudioFileInfoModal(app, info);
    modal.onOpen();
    return modal;
}

// ---------------------------------------------------------------------------
// onOpen
// ---------------------------------------------------------------------------

describe('AudioFileInfoModal.onOpen', () => {
    it('renders a "Copy as Markdown" button', () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toBe('Copy as Markdown');
    });

    it('renders an unordered list with expected file info', () => {
        const modal = makeModal(makeData());

        const listItems = modal.contentEl.querySelectorAll('li');
        expect(listItems.length).toBe(9);

        expect(listItems[0].textContent).toBe('File Name: test.webm');
        expect(listItems[1].textContent).toBe('File Path: path/to/test.webm');
        expect(listItems[2].textContent).toBe('File Size: 1.5 MB');
        expect(listItems[3].textContent).toBe('Duration: 00:01:30');
        expect(listItems[4].textContent).toBe('Container Format: audio/webm');
        expect(listItems[5].textContent).toBe('Audio Codec: opus');
        expect(listItems[6].textContent).toBe('Bitrate: 128 kbps');
        expect(listItems[7].textContent).toBe('Sample Rate: 48000 Hz');
        expect(listItems[8].textContent).toBe('Channels: 2 (Stereo)');
    });

    it('list element has the aar-audio-info-list CSS class', () => {
        const modal = makeModal();

        const ul = modal.contentEl.querySelector('ul');
        expect(ul?.classList.contains('aar-audio-info-list')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Copy button behaviour
// ---------------------------------------------------------------------------

describe('AudioFileInfoModal copy button', () => {
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

    it('calls clipboard.writeText with formatted Markdown on click', async () => {
        const data = makeData();
        const modal = makeModal(data);

        const expectedMarkdown = [
            `- **File Name:** \`${data.fileName}\``,
            `- **File Path:** \`${data.filePath}\``,
            `- **File Size:** \`${data.fileSize}\``,
            `- **Duration:** \`${data.duration}\``,
            `- **Container Format:** \`${data.containerFormat}\``,
            `- **Audio Codec:** \`${data.audioCodec}\``,
            `- **Bitrate:** \`${data.bitrate}\``,
            `- **Sample Rate:** \`${data.sampleRate}\``,
            `- **Channels:** \`${data.channels}\``,
        ].join('\n');

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expectedMarkdown);
    });

    it('changes button text to "Copied!" after click', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(btn.textContent).toBe('Copied!');
    });

    it('adds aar-audio-info-copied CSS class after click', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        expect(btn.classList.contains('aar-audio-info-copied')).toBe(true);
    });

    it('reverts button text back to "Copy as Markdown" after 2 seconds', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        jest.advanceTimersByTime(2000);

        expect(btn.textContent).toBe('Copy as Markdown');
    });

    it('removes aar-audio-info-copied CSS class after 2 seconds', async () => {
        const modal = makeModal();

        const btn = modal.contentEl.querySelector('button') as HTMLButtonElement;
        btn.click();
        await Promise.resolve();

        jest.advanceTimersByTime(2000);

        expect(btn.classList.contains('aar-audio-info-copied')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// onClose
// ---------------------------------------------------------------------------

describe('AudioFileInfoModal.onClose', () => {
    it('empties contentEl on close', () => {
        const modal = makeModal();

        expect(modal.contentEl.children.length).toBeGreaterThan(0);

        modal.onClose();

        expect(modal.contentEl.children.length).toBe(0);
    });
});
