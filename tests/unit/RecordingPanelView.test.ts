/**
 * Tests for the recording panel view: what it shows for the active file, the
 * actions it offers and runs, its buttons, its foldable sections, and when it
 * redraws.
 */

import { App, Menu } from 'obsidian';
import type { TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import {
	RecordingPanelView,
	type RecordingPanelHost,
} from 'src/panel/RecordingPanelView';
import { COMMAND_IDS, RECORDING_PANEL_VIEW_TYPE } from 'src/constants';
import { emptyTranscriptSection } from 'src/sidecar/recordingSidecarModel';
import type {
	ActionServices,
	FileAction,
	FileContext,
} from 'src/actions/PluginAction';
import { FAILING_RUNS, internalsOf, partial } from '../helpers/doubles';
import {
	asMockApp,
	asMockMenu,
	fileAt,
	leafOver,
} from '../helpers/obsidianMock';
import { allEls, el, maybeEl } from '../helpers/dom';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';
import { RECORDING_PANEL } from '../helpers/selectors';

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
		isAvailable: () => true,
		run: jest.fn(),
		cli: { name: commandId, description: title, execute: () => '' },
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
		/** What the recorder reports, idle when not given. */
		status?: ReturnType<RecordingPanelHost['recording']['getStatus']>;
		/** How many stopped recordings are being saved, none when not given. */
		saves?: number;
		/** The failed-parts record, as the sidecar answers it. */
		failedParts?: object | null;
		/** Stored settings profiles. */
		profiles?: object[];
		readDuration?: jest.Mock;
		sidecarFails?: boolean;
		/** Whether the store reports the sidecar as unreadable. */
		sidecarCorrupt?: boolean;
	} = {},
): Promise<{
	view: RecordingPanelView;
	app: App;
	host: RecordingPanelHost;
	settings: Record<string, unknown>;
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
		transcriptionEnabled: true,
	};
	const toggleRecording = jest.fn().mockResolvedValue(undefined);
	const host: RecordingPanelHost = {
		displayName: 'Advanced Audio Recorder',
		services: partial<ActionServices>({
			app,
			getSettings: () => settings,
			recordingSidecar: {
				getTranscript,
				getFailedParts: jest
					.fn()
					.mockResolvedValue(options.failedParts ?? null),
				isSidecarCorrupt: () => options.sidecarCorrupt ?? false,
				onChange: (listener: (path: string) => void) => {
					listeners.push(listener);
					return () => undefined;
				},
			},
		}),
		actions: options.actions ?? [],
		recording: {
			toggleRecording,
			getStatus: () => options.status ?? 'idle',
			getSaveState: () => ({
				status: options.saves ? 'saving' : 'idle',
				progress: undefined,
				waiting: Math.max((options.saves ?? 0) - 1, 0),
			}),
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

/** The property row of the panel with this key. */
function propertyRow(view: RecordingPanelView, key: string): HTMLElement {
	const row = maybePropertyRow(view, key);
	if (!row) {
		throw new Error(
			`No property "${key}". Properties: ${propertyKeys(view).join(', ')}`,
		);
	}
	return row;
}

/** The property row with this key, or null when the panel shows none. */
function maybePropertyRow(
	view: RecordingPanelView,
	key: string,
): HTMLElement | null {
	return (
		allEls(view.contentEl, RECORDING_PANEL.property).find(
			(row) =>
				el<HTMLInputElement>(row, RECORDING_PANEL.propertyKey).value ===
				key,
		) ?? null
	);
}

/** The keys of every property row, in order. */
function propertyKeys(view: RecordingPanelView): string[] {
	return allEls<HTMLInputElement>(
		view.contentEl,
		RECORDING_PANEL.propertyKey,
	).map((key) => key.value);
}

/** The value a property row shows. */
function propertyValue(view: RecordingPanelView, key: string): string {
	return (
		el(propertyRow(view, key), RECORDING_PANEL.propertyValue).textContent ??
		''
	);
}

/** One of the panel's own buttons, by its label. */
function panelButton(view: RecordingPanelView, label: string): HTMLElement {
	return el(view.contentEl, RECORDING_PANEL.button(label));
}

/** The labels of the file action buttons, in order. */
function actionLabels(view: RecordingPanelView): string[] {
	return allEls(view.contentEl, RECORDING_PANEL.actions).map(
		(button) => button.getAttribute('aria-label') ?? '',
	);
}

/** The titles of the panel's sections, in order. */
function sectionTitles(view: RecordingPanelView): string[] {
	return allEls(view.contentEl, RECORDING_PANEL.sectionTitle).map(
		(title) => title.textContent ?? '',
	);
}

/** The section with a title starting with this text. */
function section(view: RecordingPanelView, title: string): HTMLElement {
	const found = allEls(view.contentEl, RECORDING_PANEL.section).find(
		(candidate) =>
			el(candidate, RECORDING_PANEL.sectionTitle).textContent?.startsWith(
				title,
			),
	);
	if (!found) {
		throw new Error(`No section "${title}"`);
	}
	return found;
}

/** The hint the panel shows in place of its sections, if any. */
function hints(view: RecordingPanelView): string[] {
	return allEls(view.contentEl, RECORDING_PANEL.hint).map(
		(hint) => hint.textContent ?? '',
	);
}

/** Picks a recording in the panel's dropdown. */
async function pick(view: RecordingPanelView, path: string): Promise<void> {
	const select = el<HTMLSelectElement>(view.contentEl, 'select');
	select.value = path;
	select.dispatchEvent(new Event('change'));
	await flushMicrotasks();
}

/** A transcript naming who took part, with a profile on record. */
function transcriptWithPeople(): ReturnType<typeof emptyTranscriptSection> {
	const transcript = emptyTranscriptSection();
	transcript.participants = ['Anna', 'Boris'];
	transcript.participantProfileId = 'team';
	transcript.speakers = [
		{ label: 'Speaker 1', name: 'Boris' },
		{ label: 'Speaker 2' },
	];
	return transcript;
}

describe('the recording panel with nothing to show', () => {
	it('says what to open when no file is active', async () => {
		const { view } = await createSut();

		expect(hints(view)).toEqual([
			'Open a recording, or a note that embeds one, to see its details here.',
		]);
	});

	it('still offers its record, queue and settings buttons', async () => {
		const { view } = await createSut();

		expect(
			allEls(view.contentEl, RECORDING_PANEL.buttons).map((button) =>
				button.getAttribute('aria-label'),
			),
		).toEqual([
			'Start recording',
			'Show the transcription queue',
			'Open settings',
		]);
	});
});

describe('the recording panel on an open recording', () => {
	it('shows the file name', async () => {
		const { view } = await createSut({
			active: recording('calls/sync.webm'),
		});

		expect(propertyValue(view, 'File')).toBe('sync.webm');
	});

	it('shows the length once it has been read', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(propertyValue(view, 'Duration')).toBe('1:35');
	});

	it('shows the format in capitals', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(propertyValue(view, 'Format')).toBe('WEBM');
	});

	it('opens the recording from its file name', async () => {
		const file = recording('sync.webm');
		const { view, app } = await createSut({ active: file });

		el(view.contentEl, RECORDING_PANEL.propertyLink).click();

		expect(asMockApp(app).workspace.leaf.openFile).toHaveBeenCalledWith(
			file,
		);
	});

	it('says in one row which engine transcribed it, in which language', async () => {
		const transcript = emptyTranscriptSection();
		transcript.provenance = { model: 'deepgram', language: 'ru' };

		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript,
		});

		expect(propertyValue(view, 'Transcribed')).toBe('deepgram · ru');
	});

	it('shows no transcription row for a recording never transcribed', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(maybePropertyRow(view, 'Transcribed')).toBeNull();
	});
});

/**
 * A note's cached metadata embedding the given links, one per line, with the
 * positions Obsidian's cache always carries.
 * @param links - The link texts, in note order
 */
function embedding(...links: string[]): CachedMetadata {
	return partial<CachedMetadata>({
		embeds: links.map((link, line) => ({
			link,
			original: `![[${link}]]`,
			position: {
				start: { line, col: 0, offset: line * 100 },
				end: {
					line,
					col: link.length + 5,
					offset: line * 100 + link.length + 5,
				},
			},
		})),
	});
}

describe('the recording panel on a meeting note', () => {
	it('shows the recording the note embeds', async () => {
		const audio = recording('rec/meeting.m4a');

		const { view } = await createSut({
			active: note('Meeting.md'),
			cache: embedding('rec/meeting.m4a'),
			vaultFiles: [audio],
		});

		expect(propertyValue(view, 'File')).toBe('meeting.m4a');
	});

	/** A meeting note embedding two recordings. */
	const twoRecordings = {
		active: note('Meeting.md'),
		cache: embedding('a.m4a', 'b.m4a'),
		vaultFiles: [recording('a.m4a'), recording('b.m4a')],
	};

	it('offers a choice when the note refers to several recordings', async () => {
		const { view } = await createSut(twoRecordings);

		expect(
			Array.from(
				el<HTMLSelectElement>(view.contentEl, 'select').options,
			).map((option) => option.value),
		).toEqual(['a.m4a', 'b.m4a']);
	});

	it('offers no choice for a single recording', async () => {
		const { view } = await createSut({ active: recording('a.m4a') });

		expect(maybeEl(view.contentEl, 'select')).toBeNull();
	});

	it('switches to the recording picked in the dropdown', async () => {
		const { view } = await createSut(twoRecordings);

		await pick(view, 'b.m4a');

		expect(propertyValue(view, 'File')).toBe('b.m4a');
	});

	it('names recordings that share a file name by their path', async () => {
		const { view } = await createSut({
			active: note('Meeting.md'),
			cache: embedding('2024/standup.webm', '2025/standup.webm'),
			vaultFiles: [
				recording('2024/standup.webm'),
				recording('2025/standup.webm'),
			],
		});

		expect(
			Array.from(
				el<HTMLSelectElement>(view.contentEl, 'select').options,
			).map((option) => option.textContent),
		).toEqual(['2024/standup.webm', '2025/standup.webm']);
	});
});

describe('who took part', () => {
	/**
	 * The participants come from a profile, and a list of them is what a
	 * reader of a meeting note looks for: each person on a row of their own.
	 */
	it('lists each participant on a row of their own', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript: transcriptWithPeople(),
		});

		expect(
			allEls(section(view, 'Participants'), RECORDING_PANEL.property).map(
				(row) =>
					el<HTMLInputElement>(row, RECORDING_PANEL.propertyKey)
						.value,
			),
		).toEqual(['Anna', 'Boris']);
	});

	it('names the profile the participants came from', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript: transcriptWithPeople(),
			profiles: [
				{ id: 'team', kind: 'participants', name: 'Team', body: '' },
			],
		});

		expect(sectionTitles(view)).toContain('Participants · Team');
	});

	it('shows the speaker label given to a participant', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript: transcriptWithPeople(),
		});

		expect([
			propertyValue(view, 'Anna'),
			propertyValue(view, 'Boris'),
		]).toEqual(['', 'Speaker 1']);
	});

	it('leaves out a speaker nobody named', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			transcript: transcriptWithPeople(),
		});

		expect(maybePropertyRow(view, 'Speaker 2')).toBeNull();
	});

	it('shows no participants section when nobody is on record', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		expect(sectionTitles(view)).toEqual(['Recording']);
	});
});

describe('the actions the panel offers', () => {
	it('shows each available file action as a labelled icon, deleting left out', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [
				fileAction(COMMAND_IDS.transcribeAudio, 'Transcribe audio'),
				fileAction(COMMAND_IDS.deleteRecording, 'Delete recording'),
			],
		});

		expect(actionLabels(view)).toEqual(['Transcribe audio']);
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

		el(view.contentEl, RECORDING_PANEL.action('Transcribe audio')).click();
		await flushMicrotasks();

		expect(transcribe.run).toHaveBeenCalledWith(
			expect.objectContaining<Partial<FileContext>>({ file }),
		);
	});

	it.each(FAILING_RUNS)('logs an action that %s', async (_how, run) => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// Asserted below
		});
		const broken = fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info');
		broken.run.mockImplementation(run);
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [broken],
		});

		el(view.contentEl, RECORDING_PANEL.action('Audio file info')).click();
		await flushMicrotasks();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('audio-file-info failed'),
			expect.any(Error),
		);
	});

	const retry = (): FileAction =>
		fileAction(
			COMMAND_IDS.retryFailedParts,
			'Transcribe the parts that failed',
		);

	it('offers no top-up for a recording with no failed parts', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [retry()],
		});

		expect(actionLabels(view)).toEqual([]);
	});

	it('offers the top-up once parts failed', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [retry()],
			failedParts: {
				recordedAt: '2026-01-01T00:00:00Z',
				parts: [
					{ label: 'Part 1', message: 'timeout', startSeconds: 0 },
				],
			},
		});

		expect(actionLabels(view)).toEqual([
			'Transcribe the parts that failed',
		]);
	});
});

describe('the menus of the panel', () => {
	/**
	 * The panel's buttons and its file actions are one row: the actions
	 * first, then the record, queue and settings buttons closing it.
	 */
	it('keeps its own buttons in one row with the file actions, after them', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info')],
		});

		expect(
			allEls(view.contentEl, RECORDING_PANEL.toolbarButtons).map(
				(button) => button.getAttribute('aria-label'),
			),
		).toEqual([
			'Audio file info',
			'Start recording',
			'Show the transcription queue',
			'Open settings',
		]);
	});

	it('offers no options button of its own', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [
				fileAction(COMMAND_IDS.deleteRecording, 'Delete recording'),
			],
		});

		expect(
			maybeEl(view.contentEl, '[aria-label="More options"]'),
		).toBeNull();
	});

	it('lists the same actions in the view menu', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [
				fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info'),
				fileAction(COMMAND_IDS.deleteRecording, 'Delete recording'),
			],
		});
		const menu = new Menu();

		view.onPaneMenu(menu, 'more-options');

		expect(asMockMenu(menu).items.map((item) => item.title)).toEqual([
			'Audio file info',
			'Delete recording',
		]);
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
		await flushMicrotasks();

		expect(info.run).toHaveBeenCalledTimes(1);
	});

	it('lists nothing in the view menu while no recording is shown', async () => {
		const { view } = await createSut({
			actions: [fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info')],
		});
		const menu = new Menu();

		view.onPaneMenu(menu, 'more-options');

		expect(asMockMenu(menu).items).toHaveLength(0);
	});

	it('lists no actions in the tab header menu', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			actions: [fileAction(COMMAND_IDS.audioFileInfo, 'Audio file info')],
		});
		const menu = new Menu();

		view.onPaneMenu(menu, 'tab-header');

		expect(asMockMenu(menu).items).toHaveLength(0);
	});
});

describe('the panel buttons', () => {
	it('starts a recording from its record button', async () => {
		const { view, toggleRecording } = await createSut();

		panelButton(view, 'Start recording').click();

		expect(toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('offers to stop while a session is running', async () => {
		const { view } = await createSut({ status: 'recording' });

		expect(panelButton(view, 'Stop recording').dataset.icon).toBe('square');
	});

	// A stopped recording is saved behind the capture, so the record button
	// is free again and names the saves still running, as the ribbon does.
	it.each([
		{
			status: 'idle',
			saves: 1,
			label: 'Start recording (1 recording saving)',
		},
		{
			status: 'recording',
			saves: 2,
			label: 'Stop recording (2 recordings saving)',
		},
	] as const)(
		'names $saves save(s) running behind the $status recorder',
		async ({ status, saves, label }) => {
			const { view, toggleRecording } = await createSut({
				status,
				saves,
			});

			panelButton(view, label).click();

			expect(toggleRecording).toHaveBeenCalledTimes(1);
		},
	);

	it('labels the record button as saving while a recording is saved', async () => {
		const { view } = await createSut({ status: 'saving' });

		expect(panelButton(view, 'Saving the recording').dataset.icon).toBe(
			'save',
		);
	});

	it('disables the record button while a recording is saved', async () => {
		const { view, toggleRecording } = await createSut({ status: 'saving' });

		panelButton(view, 'Saving the recording').click();

		expect(toggleRecording).not.toHaveBeenCalled();
	});

	it('logs a start or stop that failed', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// Asserted below
		});
		const { view, toggleRecording } = await createSut();
		toggleRecording.mockRejectedValue(new Error('no microphone'));

		panelButton(view, 'Start recording').click();
		await flushMicrotasks();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Starting or stopping a recording'),
			expect.any(Error),
		);
	});

	it('opens the plugin settings', async () => {
		const { view, host } = await createSut();

		panelButton(view, 'Open settings').click();

		expect(host.openSettings).toHaveBeenCalledTimes(1);
	});

	it('shows the transcription queue', async () => {
		const { view, host } = await createSut();

		panelButton(view, 'Show the transcription queue').click();

		expect(host.openTranscriptionQueue).toHaveBeenCalledTimes(1);
	});

	/**
	 * Obsidian hides a view's own header in a sidebar, where the panel lives,
	 * so a button added to it with addAction is never seen there.
	 */
	it('adds nothing to the view header a sidebar hides', async () => {
		const { view } = await createSut();

		expect(internalsOf<{ actions: unknown[] }>(view).actions).toEqual([]);
	});
});

describe('folding a section', () => {
	it('folds a section from its heading', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		el(section(view, 'Recording'), RECORDING_PANEL.sectionHeading).click();

		expect([
			section(view, 'Recording').classList.contains('is-collapsed'),
			el(
				section(view, 'Recording'),
				RECORDING_PANEL.foldArrow,
			).classList.contains('is-collapsed'),
		]).toEqual([true, true]);
	});

	it('unfolds it again from the same heading', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });
		const heading = el(
			section(view, 'Recording'),
			RECORDING_PANEL.sectionHeading,
		);

		heading.click();
		heading.click();

		expect(
			section(view, 'Recording').classList.contains('is-collapsed'),
		).toBe(false);
	});

	it('folds from the keyboard', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		el(
			section(view, 'Recording'),
			RECORDING_PANEL.sectionHeading,
		).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(
			section(view, 'Recording').classList.contains('is-collapsed'),
		).toBe(true);
	});

	it('keeps a section folded when the panel redraws for another recording', async () => {
		const { view, app } = await createSut({ active: recording('a.webm') });
		el(section(view, 'Recording'), RECORDING_PANEL.sectionHeading).click();

		asMockApp(app).workspace.seedActiveFile(recording('b.webm'));
		app.workspace.trigger('file-open');
		await flushMicrotasks();

		expect(
			section(view, 'Recording').classList.contains('is-collapsed'),
		).toBe(true);
	});

	it('asks Obsidian to save the layout that remembers the fold', async () => {
		const { view, app } = await createSut({
			active: recording('sync.webm'),
		});

		el(section(view, 'Recording'), RECORDING_PANEL.sectionHeading).click();

		expect(asMockApp(app).workspace.requestSaveLayout).toHaveBeenCalled();
	});

	it('reports the folded sections in its saved state', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		el(section(view, 'Recording'), RECORDING_PANEL.sectionHeading).click();

		expect(view.getState()).toEqual({ collapsed: ['recording'] });
	});

	it('draws a section folded when the saved layout says so', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		await view.setState({ collapsed: ['recording'] }, { history: false });
		view.contentEl.empty();
		internalsOf<{ shownKey: string }>(view).shownKey = '';
		await view.refresh();

		expect(
			section(view, 'Recording').classList.contains('is-collapsed'),
		).toBe(true);
	});

	it('ignores a saved state it does not know', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		await view.setState({ collapsed: ['nothing', 7] }, { history: false });

		expect(view.getState()).toEqual({ collapsed: [] });
	});
});

describe('what the panel reads and shows when reading fails', () => {
	it('still shows the file when its sidecar cannot be read', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const { view } = await createSut({
			active: recording('sync.webm'),
			sidecarFails: true,
		});

		expect(propertyValue(view, 'File')).toBe('sync.webm');
	});

	it('says a sidecar it cannot read is unreadable rather than empty', async () => {
		const { view } = await createSut({
			active: recording('sync.webm'),
			sidecarCorrupt: true,
		});

		expect(hints(view)).toEqual([
			'The stored data of this recording could not be read. Restore or remove sync.webm.markers.json to see it here.',
		]);
	});

	it('shows a length nobody could read as unknown', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const { view } = await createSut({
			active: recording('sync.webm'),
			readDuration: jest.fn().mockRejectedValue(new Error('no codec')),
		});

		expect(propertyValue(view, 'Duration')).toBe('unknown');
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

	it('asks for a length again after a read that failed', async () => {
		const readDuration = jest
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValue(95);
		const { view, getTranscript } = await createSut({
			active: recording('sync.webm'),
			readDuration,
		});
		getTranscript.mockResolvedValue(transcriptWithPeople());

		await view.refresh();
		await flushMicrotasks();

		expect(propertyValue(view, 'Duration')).toBe('1:35');
	});
});

describe('the view itself', () => {
	it('carries the microphone the plugin is known by', async () => {
		const { view } = await createSut();

		expect([view.getViewType(), view.getIcon()]).toEqual([
			RECORDING_PANEL_VIEW_TYPE,
			'mic-vocal',
		]);
	});

	it('empties itself when closed', async () => {
		const { view } = await createSut({ active: recording('sync.webm') });

		await view.onClose();

		expect(view.contentEl.childElementCount).toBe(0);
	});
});

describe('what makes the panel read again', () => {
	it('a change to its sidecar', async () => {
		const { getTranscript, sidecarChanged } = await createSut({
			active: recording('sync.webm'),
		});

		sidecarChanged('sync.webm');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('not a change to a recording it is not showing', async () => {
		const { getTranscript, sidecarChanged } = await createSut({
			active: recording('sync.webm'),
		});

		sidecarChanged('other.webm');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(1);
	});

	it('the file the user opens', async () => {
		const { view, app } = await createSut({ active: recording('a.webm') });

		asMockApp(app).workspace.seedActiveFile(recording('b.webm'));
		app.workspace.trigger('file-open');
		await flushMicrotasks();

		expect(propertyValue(view, 'File')).toBe('b.webm');
	});

	it('a change to the links of the note in view', async () => {
		const { app, getTranscript } = await createSut(meetingNote());

		app.metadataCache.trigger('changed', note('Meeting.md'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('not a change to some other note', async () => {
		const { app, getTranscript } = await createSut(meetingNote());

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

	it('not the rename of a file it does not show', async () => {
		const { app, getTranscript } = await createSut({
			active: recording('sync.webm'),
		});

		app.vault.trigger('rename', recording('b.png'), 'a.png');
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(1);
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

	it('the recording itself being rewritten', async () => {
		const { app, getTranscript } = await createSut({
			active: recording('sync.webm'),
		});

		app.vault.trigger('modify', recording('sync.webm'));
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});

	it('a link the note already had starting to resolve', async () => {
		const audio = recording('later.webm');
		const { view, app } = await createSut({
			active: note('Meeting.md'),
			cache: embedding('later.webm'),
		});
		asMockApp(app).metadataCache.getFirstLinkpathDest.mockReturnValue(
			audio,
		);

		app.metadataCache.trigger('resolved');
		await flushMicrotasks();

		expect(propertyValue(view, 'File')).toBe('later.webm');
	});

	it('a change that lands while a refresh is under way', async () => {
		const { view, getTranscript, sidecarChanged, app } = await createSut();
		const release = holdNextTranscriptRead(getTranscript);
		asMockApp(app).workspace.seedActiveFile(recording('new.webm'));
		const opening = view.refresh();

		sidecarChanged('new.webm');
		release();
		await opening;
		await flushMicrotasks();

		expect(getTranscript).toHaveBeenCalledTimes(2);
	});
});

describe('when the panel redraws', () => {
	/** An action offered only while transcription is on. */
	const gated = (): FileAction => ({
		...fileAction(COMMAND_IDS.transcribeAudio, 'Transcribe audio'),
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionEnabled,
	});

	it('redraws for new settings, though its data is the same', async () => {
		const { view, settings } = await createSut({
			active: recording('sync.webm'),
			actions: [gated()],
		});
		settings.transcriptionEnabled = false;

		await view.refresh();

		expect(actionLabels(view)).toEqual([]);
	});

	it('still redraws for new settings when a later refresh overtakes it', async () => {
		const { view, settings, getTranscript } = await createSut({
			active: recording('sync.webm'),
			actions: [gated()],
		});
		const release = holdNextTranscriptRead(getTranscript);
		settings.transcriptionEnabled = false;

		const forced = view.refresh();
		const later = view.refresh();
		release();
		await Promise.all([forced, later]);

		expect(actionLabels(view)).toEqual([]);
	});

	it('keeps what it drew when a sidecar change leaves the data the same', async () => {
		const { view, sidecarChanged } = await createSut({
			active: recording('sync.webm'),
		});
		const drawn = propertyRow(view, 'File');

		sidecarChanged('sync.webm');
		await flushMicrotasks();

		expect(propertyRow(view, 'File')).toBe(drawn);
	});

	it('comes back to the picked recording once the note links its new name', async () => {
		const files = {
			a: recording('a.m4a'),
			b: recording('b.m4a'),
			renamed: recording('b2.m4a'),
		};
		const { view, app } = await createSut({
			active: note('Meeting.md'),
			cache: embedding('a.m4a', 'b.m4a'),
			vaultFiles: [files.a, files.b],
		});
		await pick(view, 'b.m4a');
		const metadata = asMockApp(app).metadataCache;
		const resolvable = new Map([
			['a.m4a', files.a],
			['b2.m4a', files.renamed],
		]);
		metadata.getFirstLinkpathDest.mockImplementation(
			(link: string) => resolvable.get(link) ?? null,
		);
		// The rename is seen first, while the note still links the old name.
		app.vault.trigger('rename', files.renamed, 'b.m4a');
		await flushMicrotasks();
		metadata.getFileCache.mockReturnValue(embedding('a.m4a', 'b2.m4a'));

		app.metadataCache.trigger('changed', note('Meeting.md'));
		await flushMicrotasks();

		expect(propertyValue(view, 'File')).toBe('b2.m4a');
	});
});

/**
 * Options for a meeting note embedding one recording.
 * @returns The options
 */
function meetingNote(): Parameters<typeof createSut>[0] {
	return {
		active: note('Meeting.md'),
		cache: embedding('sync.webm'),
		vaultFiles: [recording('sync.webm')],
	};
}

/**
 * Makes the next transcript read wait until released, so a test can act
 * while a refresh is still reading.
 * @param getTranscript - The sidecar double's transcript reader
 * @returns Releases the held read with an empty transcript
 */
function holdNextTranscriptRead(getTranscript: jest.Mock): () => void {
	let release: () => void = () => undefined;
	getTranscript.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => {
					resolve(emptyTranscriptSection());
				};
			}),
	);
	return () => {
		release();
	};
}
