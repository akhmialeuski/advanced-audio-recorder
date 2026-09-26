/**
 * Tests for the transcript actions: resolving a selection into the transcript
 * line it lies in (from the editor menu and from the palette), the action's
 * availability, and what running it opens.
 */

import type { Editor } from 'obsidian';
import {
	activeTranscriptSelection,
	TRANSCRIPT_ACTIONS,
	transcriptSelectionIn,
} from 'src/actions/transcriptActions';
import type { ActionServices } from 'src/actions/PluginAction';
import { TranscriptSplitModal } from 'src/ui/TranscriptSplitModal';
import { at } from '../helpers/assertions';
import {
	createFile,
	createMarkdownView,
	createMockApp,
} from '../helpers/createApp';
import { partial } from '../helpers/doubles';
import { cachedLink } from '../helpers/transcriptFixtures';

jest.mock('src/ui/TranscriptSplitModal', () => ({
	TranscriptSplitModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

const LINE = '[[rec.m4a#t=5|0:05]] **Speaker 1** Sure. Go ahead.';
const note = createFile('Notes/meeting.md');
const audio = createFile('audio/rec.m4a');

/** Services over an app whose note links line 0 to the recording. */
function createServices(
	transcriptionEnabled = true,
	linked = audio,
): ActionServices {
	const { app } = createMockApp({
		metadataCache: {
			getFileCache: () => ({
				links: [cachedLink('rec.m4a#t=5', 0, 0, 20)],
			}),
			getFirstLinkpathDest: () => linked,
		},
	});
	return partial<ActionServices>({
		app,
		getSettings: () => ({ transcriptionEnabled }),
		recordingSidecar: {},
	});
}

/** An editor over the transcript line with the given selection. */
function editorSelecting(
	from: { line: number; ch: number },
	to: { line: number; ch: number },
): Editor {
	return partial<Editor>({
		somethingSelected: () => from.line !== to.line || from.ch !== to.ch,
		getCursor: (which?: string) => (which === 'to' ? to : from),
		getLine: () => LINE,
	});
}

const splitAction = at(TRANSCRIPT_ACTIONS, 0);

describe('transcriptSelectionIn', () => {
	it('resolves a selection in a transcript line to its recording', () => {
		const context = transcriptSelectionIn(
			createServices(),
			editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
			note,
		);

		expect(context).toMatchObject({
			audio,
			line: 0,
			from: 35,
			to: 40,
			seconds: 5,
		});
	});

	it('does not resolve a selection that spans two lines', () => {
		expect(
			transcriptSelectionIn(
				createServices(),
				editorSelecting({ line: 0, ch: 35 }, { line: 1, ch: 2 }),
				note,
			),
		).toBeNull();
	});

	it('does not resolve a line whose link points at a note', () => {
		expect(
			transcriptSelectionIn(
				createServices(true, createFile('Notes/other.md')),
				editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
				note,
			),
		).toBeNull();
	});
});

describe('activeTranscriptSelection', () => {
	it('resolves the selection of the active editor', () => {
		const services = createServices();
		const view = createMarkdownView({ file: note });
		Object.assign(view, {
			editor: editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
		});
		jest.mocked(services.app.workspace.getActiveViewOfType).mockReturnValue(
			view,
		);

		expect(activeTranscriptSelection(services)()?.audio).toBe(audio);
	});

	it('resolves nothing without an active Markdown editor', () => {
		const services = createServices();
		jest.mocked(services.app.workspace.getActiveViewOfType).mockReturnValue(
			null,
		);

		expect(activeTranscriptSelection(services)()).toBeNull();
	});
});

describe('the split action', () => {
	function contextFor(transcriptionEnabled: boolean) {
		const context = transcriptSelectionIn(
			createServices(transcriptionEnabled),
			editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
			note,
		);
		if (!context) {
			throw new Error('The selection did not resolve');
		}
		return context;
	}

	it('is offered while transcription is enabled', () => {
		expect(splitAction.isAvailable(contextFor(true))).toBe(true);
	});

	it('is not offered while transcription is disabled', () => {
		expect(splitAction.isAvailable(contextFor(false))).toBe(false);
	});

	it('opens the split dialog on the selection', () => {
		const context = contextFor(true);

		void splitAction.run(context);

		expect(TranscriptSplitModal).toHaveBeenCalledWith(
			context.services.app,
			context,
			expect.objectContaining({
				sidecar: context.services.recordingSidecar,
			}),
		);
	});
});
