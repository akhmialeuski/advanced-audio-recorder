/**
 * Unit tests for SystemInfoModal.
 * @module tests/unit/SystemInfoModal.test
 */

import { SystemInfoModal } from 'src/diagnostics/SystemInfoModal';
import type {
	ActiveRecordingConfig,
	DiagnosticsData,
} from 'src/diagnostics/SystemDiagnostics';
import { App } from 'obsidian';
import { el } from '../helpers/dom';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The resolved recording config the modal renders under "Active config". */
function makeActiveRecordingConfig(): ActiveRecordingConfig {
	return {
		outputFormat: 'webm',
		recorderFormat: 'webm',
		mimeType: 'audio/webm',
		expectedCodec: 'opus',
		mimeTypeSupported: true,
		validationResult: { valid: true, reason: '' },
	};
}

function makeData(overrides: Partial<DiagnosticsData> = {}): DiagnosticsData {
	return {
		activeRecordingConfig: makeActiveRecordingConfig(),
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
			codecSupport: [
				{
					mimeType: 'audio/webm',
					supported: true,
					withCodecs: [
						{
							codec: 'opus',
							mimeType: 'audio/webm;codecs=opus',
							supported: true,
						},
					],
				},
			],
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

		const btn = modal.contentEl.querySelector(
			'button',
		) as HTMLButtonElement;
		btn.click();
		await Promise.resolve();

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			expectedJson,
		);
	});

	/**
	 * Presses the copy button and lets the clipboard write settle.
	 * @returns The button, so a test reads its state back
	 */
	async function pressCopy(): Promise<HTMLButtonElement> {
		const modal = makeModal();
		const button = el<HTMLButtonElement>(modal.contentEl, 'button');
		button.click();
		await Promise.resolve();
		return button;
	}

	it.each([
		// Both sides of the two-second revert. The confirmation is the only
		// feedback a copy gives, so it has to still be there at 1999 ms and
		// gone at 2000 - an off-by-one either way is a button that either
		// flickers or stays stuck on "Copied!".
		{ name: 'the moment it is pressed', afterMs: 0, copied: true },
		{ name: 'a tick before the revert', afterMs: 1999, copied: true },
		{ name: 'exactly on the revert', afterMs: 2000, copied: false },
		{ name: 'well after the revert', afterMs: 5000, copied: false },
	])('confirms the copy $name: $copied', async ({ afterMs, copied }) => {
		const button = await pressCopy();

		jest.advanceTimersByTime(afterMs);

		expect(button.textContent).toBe(
			copied ? 'Copied!' : 'Copy to clipboard',
		);
		expect(button.classList.contains('aar-system-info-copied')).toBe(
			copied,
		);
	});

	it('empties contentEl on close', () => {
		const modal = makeModal();

		expect(modal.contentEl.children.length).toBeGreaterThan(0);

		modal.onClose();

		expect(modal.contentEl.children).toHaveLength(0);
	});
});
