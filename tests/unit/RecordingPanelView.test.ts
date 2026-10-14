/**
 * Tests for the recording panel view: what it shows for the active file, the
 * actions it offers and runs, its header buttons, and when it redraws.
 */

import { App, Menu } from 'obsidian';
import type { TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import {
	RecordingPanelView,
	type RecordingPanelHost,
} from 'src/panel/RecordingPanelView';
import {
	COMMAND_IDS,
	RECORDING_PANEL_ICON,
	RECORDING_PANEL_VIEW_TYPE,
} from 'src/constants';
import { emptyTranscriptSection } from 'src/sidecar/recordingSidecarModel';
import type {
	ActionServices,
	FileAction,
	FileContext,
} from 'src/actions/PluginAction';
import { partial } from '../helpers/doubles';
import {
	asMockApp,
	asMockMenu,
	fileAt,
	headerAction,
	leafOver,
} from '../helpers/obsidianMock';
import { allEls, el } from '../helpers/dom';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';
import { SETTING } from '../helpers/selectors';
import {
	hasSettingRow,
	rowDescription,
	rowOptionValues,
	rowSelect,
	rowToggle,
	settingRow,
} from '../helpers/settingRows';

/** A file action double that records the file it ran on. */
function fileAction(
	commandId: string,
	title: string,
): FileAction & {
	run: jest.Mock;
} {
	return {
		commandId,
		title,
		icon: 'info',
		showInEditorMenu: true,
		isAvailable: () => true,
		run: jest.fn(),
	};
}

/** The panel over an app whose active file and sidecar a test chooses. */
async function createSut(
	options: {
		active?: TFile | null;
		cache?: CachedMetadata | null;
		vaultFiles?: TFile[];
		transcript?: ReturnType<typeof emptyTranscriptSection>;
		actions?: FileAction[];
		sessionActive?: boolean;
		transcriptionEnabled?: boolean;
		/** Stored markers, as the sidecar answers them. */
		markers?: object[];
		/** The failed-parts record, as the sidecar answers it. */
		failedParts?: object | null;
		/** Stored settings profiles. */
		profiles?: object[];
		readDuration?: jest.Mock;
		sidecarFails?: boolean;
	} = {},
): Promise<{
	view: RecordingPanelView;
	app: App;
	host: RecordingPanelHost;
	settings: Record<string, unknown>;
	saveSettings: jest.Mock;
	toggleRecording: jest.Mock;
	sidecarChanged: (path: string) => void;
	getTranscript: jest.Mock;
}> {
	const app = new App();
	const mockApp = asMockApp(app);
	mockApp.workspace.seedActiveFile(options.active ?? null);
	mockApp.metadataCache.getFileCache.mockReturnValue(options.cache ?? null);
	const files = new Map(
		(options.vaultFiles ?? []).map((file) => [file.path, file]),
	);
	mockApp.metadataCache.getFirstLinkpathDest.mockImplementation(
		(link: string) => files.get(link) ?? null,
	);
	const listeners: Array<(path: string) => void> = [];
	const getTranscript = options.sidecarFails
		? jest.fn().mockRejectedValue(new Error('unreadable'))
		: jest
				.fn()
				.mockResolvedValue(
					options.transcript ?? emptyTranscriptSection(),
				);
	const settings: Record<string, unknown> = {
		profiles: options.profiles ?? [],
		transcriptionEnabled: options.transcriptionEnabled ?? true,
		transcribeOnSave: false,
		enhancedPlayerEnabled: true,
	};
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const toggleRecording = jest.fn().mockResolvedValue(undefined);
	const host: RecordingPanelHost = {
		displayName: 'Advanced Audio Recorder',
		services: partial<ActionServices>({
			app,
			getSettings: () => settings,
			saveSettings,
			recordingSidecar: {
				getTranscript,
				getMarkers: jest.fn().mockResolvedValue(options.markers ?? []),
				getFailedParts: jest
					.fn()
					.mockResolvedValue(options.failedParts ?? null),
				onChange: (listener: (path: string) => void) => {
					listeners.push(listener);
					return () => undefined;
				},
			},
		}),
		actions: options.actions ?? [],
		recording: {
			toggleRecording,
			isSessionActive: () => options.sessionActive ?? false,
		},
		readDuration: options.readDuration ?? jest.fn().mockResolvedValue(95),
		openSettings: jest.fn(),
		openTranscriptionQueue: jest.fn(),
	};
	const view = new RecordingPanelView(leafOver(app), host);
	await view.onOpen();
	await flushMicrotasks();
	return {
		view,
		app,
		host,
		settings,
		saveSettings,
		toggleRecording,
		sidecarChanged: (path) => {
			listeners.forEach((listener) => listener(path));
		},
		getTranscript,
	};
}

/** A note at a path. */
function note(path: string): TFile {
	return fileAt(path);
}

/** A recording file of a given size. */
function recording(path: string, size = 2048): TFile {
	const file = fileAt(path);
	file.stat = { size, mtime: 1, ctime: 0 };
	return file;
}

describe('the recording panel with nothing to show', () => {
	it('says what to open when no file is active', async () => {
		const { view } = await createSut();

		expect(
			allEls(view.contentEl, SETTING.description)[0]?.textContent,
		).toBe(
			'Open a recording, or a note that embeds one, to see its details here.',
		);
	});

	it('still offers the quick settings', async () => {
		const { view } = await createSut();

		expect(hasSettingRow(view.contentEl, 'Enhanced audio player')).toBe(
			true,
		);
	});
});

describe('the recording panel on an open recording', () => {
	it('shows the file name', async () => {
		const { view } = await createSut({
			active: recording('calls/sync.webm'),
		});

		expect(rowDescription(settingRow(view.contentEl, 'File'))).toBe(
			'sync.webm',
		);
	});

	it('shows the length once it has been read', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(rowDescription(settingRow(view.contentEl, 'Duration'))).toBe(
			'1:35',
		);
	});

	it('says a recording was not transcribed when nothing is stored', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(textsOfDescriptions(view)).toContain('Not transcribed yet.');
	});

	it('names the speakers the user renamed', async () => {
		const transcript = emptyTranscriptSection();
		transcript.speakers = [{ label: 'Speaker 1', name: 'Anna' }];

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
		});

		expect(rowDescription(settingRow(view.contentEl, 'Speaker 1'))).toBe(
			'Anna',
		);
	});

	it('shows the model the transcript came from', async () => {
		const transcript = emptyTranscriptSection();
		transcript.provenance = { model: 'nova-3' };
		transcript.noteOutputs = [];
		transcript.fileOutputs = [
			{ path: 'sync.json', format: 'json', writtenAt: '' },
		];

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
		});

		expect(rowDescription(settingRow(view.contentEl, 'Model'))).toBe(
			'nova-3',
		);
	});
});

describe('the recording panel on a meeting note', () => {
	it('shows the recording the note embeds', async () => {
		const audio = recording('rec/meeting.m4a');

		const { view } = await createSut({
			active: note('Meeting.md'),
			cache: { embeds: [{ link: 'rec/meeting.m4a' }] } as CachedMetadata,
			vaultFiles: [audio],
		});

		expect(rowDescription(settingRow(view.contentEl, 'File'))).toBe(
			'meeting.m4a',
		);
	});

	/** A meeting note embedding two recordings. */
	const twoRecordings = {
		active: note('Meeting.md'),
		cache: {
			embeds: [{ link: 'a.m4a' }, { link: 'b.m4a' }],
		} as CachedMetadata,
		vaultFiles: [recording('a.m4a'), recording('b.m4a')],
	};

	it('offers a choice when the note refers to several recordings', async () => {
		const { view } = await createSut(twoRecordings);

		expect(rowOptionValues(settingRow(view.contentEl, 'Shown'))).toEqual([
			'a.m4a',
			'b.m4a',
		]);
	});

	it('switches to the recording picked in the dropdown', async () => {
		const { view } = await createSut(twoRecordings);
		const select = rowSelect(settingRow(view.contentEl, 'Shown'));

		select.value = 'b.m4a';
		select.dispatchEvent(new Event('change'));
		await flushMicrotasks();

		expect(rowDescription(settingRow(view.contentEl, 'File'))).toBe(
			'b.m4a',
		);
	});
});

describe('the actions the panel offers', () => {
	it('lists the available file actions but not deleting the recording', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [
				fileAction(COMMAND_IDS.transcribeAudio, 'Transcribe audio'),
				fileAction(COMMAND_IDS.deleteRecording, 'Delete recording'),
			],
		});

		expect(hasSettingRow(view.contentEl, 'Transcribe audio')).toBe(true);
		expect(hasSettingRow(view.contentEl, 'Delete recording')).toBe(false);
	});

	it('runs an action on the recording shown', async () => {
		const transcribe = fileAction(
			COMMAND_IDS.transcribeAudio,
			'Transcribe audio',
		);
		const file = recording('sync.webm');
		const { view } = await createSut({
			active: file,
			actions: [transcribe],
		});

		allEls(
			settingRow(view.contentEl, 'Transcribe audio'),
			SETTING.extraButton,
		)[0]?.click();

		expect(transcribe.run).toHaveBeenCalledWith(
			expect.objectContaining<Partial<FileContext>>({ file }),
		);
	});

	it('lists the same actions in the view menu', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info')],
		});
		const menu = new Menu();

		view.onPaneMenu(menu, 'more-options');

		expect(asMockMenu(menu).items.map((item) => item.title)).toEqual([
			'Audio file info',
		]);
	});
});

describe('the panel header', () => {
	it('starts a recording from its record button', async () => {
		const { view, toggleRecording } = await createSut();

		headerAction(view, 'Start recording').click();

		expect(toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('offers to stop while a session is running', async () => {
		const { view } = await createSut({ sessionActive: true });

		expect(headerAction(view, 'Stop recording').dataset.icon).toBe(
			'square',
		);
	});

	it('opens the plugin settings', async () => {
		const { view, host } = await createSut();

		headerAction(view, 'Open settings').click();

		expect(host.openSettings).toHaveBeenCalledTimes(1);
	});
});

describe('the quick settings', () => {
	it('saves a switch the user flipped', async () => {
		const { view, settings, saveSettings } = await createSut();

		rowToggle(settingRow(view.contentEl, 'Enhanced audio player')).click();
		await flushMicrotasks();

		expect(settings.enhancedPlayerEnabled).toBe(false);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it('hides transcribing after recording while transcription is off', async () => {
		const { view } = await createSut({ transcriptionEnabled: false });

		expect(
			hasSettingRow(view.contentEl, 'Transcribe after recording'),
		).toBe(false);
	});
});

describe('redrawing the panel', () => {
	it('re-reads the recording when its sidecar changes', async () => {
		const { getTranscript, sidecarChanged } = await createSut({
			active: recording('sync.webm'),
		});

		sidecarChanged('sync.webm');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('ignores a change to a recording it is not showing', async () => {
		const { getTranscript, sidecarChanged } = await createSut({
			active: recording('sync.webm'),
		});

		sidecarChanged('other.webm');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(1);
	});

	it('follows the file the user opens', async () => {
		const { view, app } = await createSut({ active: recording('a.webm') });

		asMockApp(app).workspace.seedActiveFile(recording('b.webm'));
		app.workspace.trigger('file-open');
		await flushMicrotasks();

		expect(rowDescription(settingRow(view.contentEl, 'File'))).toBe(
			'b.webm',
		);
	});
});

/** Every row description the panel shows, in order. */
function textsOfDescriptions(view: RecordingPanelView): string[] {
	return allEls(view.contentEl, SETTING.description).map(
		(node) => node.textContent ?? '',
	);
}

describe('what the panel reads from the sidecar', () => {
	it('counts the chapters the recording carries', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			markers: [
				{ id: 'a', time: 1, label: 'Intro', kind: 'chapter' },
				{ id: 'b', time: 9, label: 'Note', kind: 'bookmark' },
			],
		});

		expect(rowDescription(settingRow(view.contentEl, 'Chapters'))).toBe(
			'1',
		);
	});

	it('names the participants profile the names came from', async () => {
		const transcript = emptyTranscriptSection();
		transcript.participants = ['Anna', 'Boris'];
		transcript.participantProfileId = 'team';

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
			profiles: [
				{ id: 'team', kind: 'participants', name: 'Team', body: '' },
			],
		});

		expect(rowDescription(settingRow(view.contentEl, 'Profile'))).toBe(
			'Team',
		);
	});

	it('lists the participant names on one row', async () => {
		const transcript = emptyTranscriptSection();
		transcript.participants = ['Anna', 'Boris'];

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
		});

		expect(rowDescription(settingRow(view.contentEl, 'Names'))).toBe(
			'Anna, Boris',
		);
	});

	it('marks a speaker nobody named yet', async () => {
		const transcript = emptyTranscriptSection();
		transcript.speakers = [{ label: 'Speaker 2' }];

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
		});

		expect(rowDescription(settingRow(view.contentEl, 'Speaker 2'))).toBe(
			'not named',
		);
	});

	it('shows the template the transcript of the note in view was written with', async () => {
		const { view } = await createSut(transcribedInto('Meeting.md'));

		expect(rowDescription(settingRow(view.contentEl, 'Template'))).toBe(
			'{speaker}: {text}',
		);
	});

	it('shows the language of the transcript', async () => {
		const { view } = await createSut(transcribedInto('Meeting.md'));

		expect(rowDescription(settingRow(view.contentEl, 'Language'))).toBe(
			'en',
		);
	});

	it('shows when the recording was transcribed', async () => {
		const { view } = await createSut(transcribedInto('Meeting.md'));

		expect(
			rowDescription(settingRow(view.contentEl, 'Transcribed')),
		).not.toBe('');
	});

	it('opens a note the transcript was written into', async () => {
		const { view, app } = await createSut(transcribedInto('Meeting.md'));

		el(settingRow(view.contentEl, 'Note'), SETTING.extraButton).click();

		expect(asMockApp(app).workspace.openLinkText).toHaveBeenCalledWith(
			'Meeting.md',
			'Meeting.md',
			false,
		);
	});

	it('counts the parts the last run could not transcribe', async () => {
		const { view } = await createSut({
			...transcribedInto('Meeting.md'),
			failedParts: {
				recordedAt: '2026-01-01T00:00:00Z',
				parts: [
					{ label: 'Part 1', message: 'timeout', startSeconds: 0 },
				],
			},
		});

		expect(rowDescription(settingRow(view.contentEl, 'Failed parts'))).toBe(
			'1',
		);
	});

	it('still shows the file when its sidecar cannot be read', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const { view } = await createSut({
			active: recording('sync.webm'),
			sidecarFails: true,
		});

		expect(rowDescription(settingRow(view.contentEl, 'File'))).toBe(
			'sync.webm',
		);
	});

	it('shows a length nobody could read as unknown', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const { view } = await createSut({
			active: recording('sync.webm'),
			readDuration: jest.fn().mockRejectedValue(new Error('no codec')),
		});

		expect(rowDescription(settingRow(view.contentEl, 'Duration'))).toBe(
			'unknown',
		);
	});

	it('reads the length of one version of a file only once', async () => {
		const readDuration = jest.fn().mockResolvedValue(10);
		const { view } = await createSut({
			active: recording('sync.webm'),
			readDuration,
		});

		await view.refresh();
		await flushMicrotasks();

		expect(readDuration).toHaveBeenCalledTimes(1);
	});
});

describe('the view menu and the header', () => {
	it('lists nothing in the view menu while no recording is shown', async () => {
		const { view } = await createSut({
			actions: [fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info')],
		});
		const menu = new Menu();

		view.onPaneMenu(menu, 'more-options');

		expect(asMockMenu(menu).items).toHaveLength(0);
	});

	it('runs an action picked from the view menu', async () => {
		const info = fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info');
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [info],
		});
		const menu = new Menu();
		view.onPaneMenu(menu, 'more-options');

		at(asMockMenu(menu).items, 0).click();

		expect(info.run).toHaveBeenCalledTimes(1);
	});

	it('logs an action that failed', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// Asserted below
		});
		const broken = fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info');
		broken.run.mockRejectedValue(new Error('boom'));
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [broken],
		});

		el(
			settingRow(view.contentEl, 'Audio file info'),
			SETTING.extraButton,
		).click();
		await flushMicrotasks();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('audio-file-info failed'),
			expect.any(Error),
		);
	});

	it('shows the transcription queue', async () => {
		const { view, host } = await createSut();

		headerAction(view, 'Show the transcription queue').click();

		expect(host.openTranscriptionQueue).toHaveBeenCalledTimes(1);
	});

	it('carries the microphone the plugin is known by', async () => {
		const { view } = await createSut();

		expect([view.getViewType(), view.getIcon()]).toEqual([
			RECORDING_PANEL_VIEW_TYPE,
			RECORDING_PANEL_ICON,
		]);
	});

	it('empties itself when closed', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		await view.onClose();

		expect(view.contentEl.childElementCount).toBe(0);
	});
});

describe('what makes the panel read again', () => {
	it('a change to the links of the note in view', async () => {
		const { app, getTranscript } = await createSut(
			transcribedInto('Meeting.md'),
		);

		app.metadataCache.trigger('changed', note('Meeting.md'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('not a change to some other note', async () => {
		const { app, getTranscript } = await createSut(
			transcribedInto('Meeting.md'),
		);

		app.metadataCache.trigger('changed', note('Other.md'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(1);
	});

	it('a renamed file, which may be the recording shown', async () => {
		const { app, getTranscript } = await createSut({
			active: recording('sync.webm'),
		});

		app.vault.trigger('rename', recording('new.webm'), 'sync.webm');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('the recording shown being deleted', async () => {
		const { app, getTranscript } = await createSut({
			active: recording('sync.webm'),
		});

		app.vault.trigger('delete', recording('sync.webm'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('not some other file being deleted', async () => {
		const { app, getTranscript } = await createSut({
			active: recording('sync.webm'),
		});

		app.vault.trigger('delete', recording('other.webm'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(1);
	});
});

/**
 * Options for a meeting note whose recording was transcribed into it, with a
 * line template, a language, and a time on record.
 * @param notePath - The meeting note
 */
function transcribedInto(notePath: string): Parameters<typeof createSut>[0] {
	const transcript = emptyTranscriptSection();
	transcript.provenance = {
		language: 'en',
		createdAt: '2026-05-01T10:00:00Z',
	};
	transcript.noteOutputs = [
		{
			path: notePath,
			heading: '',
			writtenAt: '2026-05-01T10:00:00Z',
			templates: {
				lineFormat: '{speaker}: {text}',
				speakerFormat: '**{speaker}**',
				includeTimestamps: true,
				timestampLinks: true,
				mergeConsecutiveSpeaker: true,
			},
		},
	];
	return {
		active: note(notePath),
		cache: { embeds: [{ link: 'sync.webm' }] } as CachedMetadata,
		vaultFiles: [recording('sync.webm')],
		transcript,
	};
}
