/**
 * What the plugin does the moment a recording finishes.
 *
 * The path from "the recorder saved a file" to "a transcription dialog is
 * open" crosses four settings, a platform check, and a vault lookup, and it is
 * the one sequence a user hits after every single recording. No layer covered
 * it: the unit suites stop at the recorder, and the integration suites start at
 * the dialog.
 * @module tests/e2e/recordThenTranscribe.e2e.test
 */

import { App } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type { RecordingSaveResult } from 'src/types';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { at } from '../helpers/assertions';
import { setPlatform } from '../helpers/platform';
import { asMockVault } from '../helpers/obsidianMock';
import { noticeMessages } from '../mocks/obsidian';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import { RecordingManager } from 'src/recording/RecordingManager';
import { loadPlugin } from '../helpers/pluginHarness';

jest.mock('src/ui/TranscriptionModal', () => ({
	TranscriptionModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));
jest.mock('src/recording/silentChannelDetector', () => ({
	detectSilentChannel: jest.fn().mockResolvedValue(null),
}));

/** Settings that would auto-transcribe, so a case states only what it changes. */
function transcribingSettings(
	patch: Partial<AudioRecorderSettings> = {},
): Partial<AudioRecorderSettings> {
	return {
		transcriptionEnabled: true,
		transcribeOnSave: true,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		...patch,
	};
}

/** Loads a plugin whose vault holds the recording that was just saved. */
async function loadWithRecording(
	settings: Partial<AudioRecorderSettings>,
	options: { seedRecording?: boolean } = {},
): Promise<AudioRecorderPlugin> {
	const app = new App();
	if (options.seedRecording !== false) {
		asMockVault(app.vault).seed([{ path: 'Recordings/take.webm' }]);
	}
	return (await loadPlugin(settings, app)).plugin;
}

/** Reports a finished recording through the callback the plugin registered. */
function reportSaved(result: Partial<RecordingSaveResult> = {}): void {
	const onSaved = at(jest.mocked(RecordingManager).mock.calls, 0)[5] as (
		saved: RecordingSaveResult,
	) => void;
	onSaved({
		audioPaths: ['Recordings/take.webm'],
		notePath: 'Notes/daily.md',
		durationSeconds: 42,
		...result,
	});
}

beforeEach(() => {
	setPlatform({ isMobile: false, isMobileApp: false });
});

describe('a recording that should be transcribed', () => {
	it('opens the transcription dialog over the file that was saved', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved();

		expect(TranscriptionModal).toHaveBeenCalledTimes(1);
		const [, file] = at(jest.mocked(TranscriptionModal).mock.calls, 0);
		expect(file.path).toBe('Recordings/take.webm');
	});

	it('starts the run itself rather than waiting to be asked', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved();

		const options = at(jest.mocked(TranscriptionModal).mock.calls, 0)[3];
		expect(options).toMatchObject({ autoStart: true });
	});

	it('tells the dialog which note the recording went into', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved({ notePath: 'Notes/meeting.md' });

		const options = at(jest.mocked(TranscriptionModal).mock.calls, 0)[3];
		expect(options).toMatchObject({ notePath: 'Notes/meeting.md' });
	});

	it('opens the dialog it built', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved();

		const dialog = at(jest.mocked(TranscriptionModal).mock.results, 0)
			.value as { open: jest.Mock };
		expect(dialog.open).toHaveBeenCalled();
	});

	it('transcribes the first file of a multi-track recording', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved({
			audioPaths: ['Recordings/take.webm', 'Recordings/take-2.webm'],
		});

		const [, file] = at(jest.mocked(TranscriptionModal).mock.calls, 0);
		expect(file.path).toBe('Recordings/take.webm');
	});
});

describe('a recording that should not be transcribed', () => {
	it.each([
		{
			name: 'transcription is off entirely',
			settings: transcribingSettings({ transcriptionEnabled: false }),
		},
		{
			name: 'transcribe-on-save is off',
			settings: transcribingSettings({ transcribeOnSave: false }),
		},
	])('stays out of the way when $name', async ({ settings }) => {
		await loadWithRecording(settings);

		reportSaved();

		expect(TranscriptionModal).not.toHaveBeenCalled();
	});

	it('stays out of the way when the recording produced no audio', async () => {
		await loadWithRecording(transcribingSettings());

		reportSaved({ audioPaths: [] });

		expect(TranscriptionModal).not.toHaveBeenCalled();
	});

	it('stays out of the way when the saved file is not in the vault yet', async () => {
		await loadWithRecording(transcribingSettings(), {
			seedRecording: false,
		});

		reportSaved();

		expect(TranscriptionModal).not.toHaveBeenCalled();
	});
});

describe('a recording on a device that cannot run the chosen engine', () => {
	it('says the run was skipped instead of opening a doomed dialog', async () => {
		// A synced desktop config can select local whisper.cpp, which no
		// mobile device can run: auto-starting would pop a failing dialog
		// after every single recording.
		await loadWithRecording(
			transcribingSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
		);
		setPlatform({ isMobile: true, isMobileApp: true });

		reportSaved();

		expect(TranscriptionModal).not.toHaveBeenCalled();
		expect(
			noticeMessages().some((message) =>
				message.includes('Transcription was skipped'),
			),
		).toBe(true);
	});

	it('names the way out, not only the problem', async () => {
		await loadWithRecording(
			transcribingSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
		);
		setPlatform({ isMobile: true, isMobileApp: true });

		reportSaved();

		expect(
			noticeMessages().some((message) =>
				message.includes('Pick a cloud engine in settings'),
			),
		).toBe(true);
	});

	it('runs the same engine happily on a device that supports it', async () => {
		await loadWithRecording(
			transcribingSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
		);
		setPlatform({ isMobile: false, isMobileApp: false });

		reportSaved();

		expect(TranscriptionModal).toHaveBeenCalledTimes(1);
	});
});
