/**
 * Tests for the transcript actions: resolving a selection into the transcript
 * lines it lies over (from the editor menu and from the palette), each
 * action's availability, and what running it opens.
 */

import type { Editor } from 'obsidian';
import {
	activeTranscriptSelection,
	TRANSCRIPT_ACTIONS,
	transcriptSelectionIn,
} from 'src/actions/transcriptActions';
import type {
	ActionServices,
	TranscriptSelectionContext,
} from 'src/actions/PluginAction';
import { TranscriptMergeModal } from 'src/ui/TranscriptMergeModal';
import { TranscriptSplitModal } from 'src/ui/TranscriptSplitModal';
import { at } from '../helpers/assertions';
import {
	createFile,
	createMarkdownView,
	createMockApp,
} from '../helpers/createApp';
import { partial } from '../helpers/doubles';

jest.mock('src/ui/TranscriptSplitModal', () => ({
	TranscriptSplitModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));
jest.mock('src/ui/TranscriptMergeModal', () => ({
	TranscriptMergeModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

const LINE = '[[rec.m4a#t=5|0:05]] **Speaker 1** Sure. Go ahead.';
const note = createFile('Notes/meeting.md');
const audio = createFile('audio/rec.m4a');

/** Services over an app whose links resolve to the given recording. */
function createServices(
	transcriptionEnabled = true,
	linked = audio,
): ActionServices {
	const { app } = createMockApp({
		metadataCache: {
			getFirstLinkpathDest: () => linked,
		},
	});
	return partial<ActionServices>({
		app,
		getSettings: () => ({ transcriptionEnabled }),
		recordingSidecar: {},
	});
}

const SECOND_LINE = '[[rec.m4a#t=9|0:09]] **Bob** Thanks.';

/**
 * An editor with the given selection, over the given lines (by default the
 * transcript line on every line).
 */
function editorSelecting(
	from: { line: number; ch: number },
	to: { line: number; ch: number },
	lines?: readonly string[],
): Editor {
	return partial<Editor>({
		somethingSelected: () => from.line !== to.line || from.ch !== to.ch,
		getCursor: (which?: string) => (which === 'to' ? to : from),
		getLine: (line: number) => (lines ? (lines[line] ?? '') : LINE),
	});
}

/** Two transcript lines with the blank line the renderer puts between them. */
const TWO_LINES = [LINE, '', SECOND_LINE];

const splitAction = at(TRANSCRIPT_ACTIONS, 0);
const mergeAction = at(TRANSCRIPT_ACTIONS, 1);

/** Resolves a selection, failing the test when it does not resolve. */
function resolved(
	editor: Editor,
	transcriptionEnabled = true,
): TranscriptSelectionContext {
	const context = transcriptSelectionIn(
		createServices(transcriptionEnabled),
		editor,
		note,
	);
	if (!context) {
		throw new Error('The selection did not resolve');
	}
	return context;
}

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

	it('resolves a selection over several lines to the lines it covers', () => {
		const context = resolved(
			editorSelecting(
				{ line: 0, ch: 35 },
				{ line: 2, ch: 30 },
				TWO_LINES,
			),
		);

		expect(context).toMatchObject({
			audio,
			line: 0,
			lastLine: 2,
			lineText: LINE,
			lineTexts: TWO_LINES,
			from: 35,
			to: 30,
			seconds: 5,
		});
	});

	it('resolves a selection inside one line as that line alone', () => {
		expect(
			resolved(editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 })),
		).toMatchObject({ lastLine: 0, lineTexts: [LINE] });
	});

	it('leaves out a line the selection only reaches the start of', () => {
		// Selecting whole lines ends the selection at the start of the next.
		const context = resolved(
			editorSelecting({ line: 0, ch: 0 }, { line: 3, ch: 0 }, [
				...TWO_LINES,
				LINE,
			]),
		);

		expect(context).toMatchObject({
			line: 0,
			lastLine: 2,
			to: SECOND_LINE.length,
		});
	});

	it('leaves out a line the selection only starts at the end of', () => {
		const context = resolved(
			editorSelecting(
				{ line: 0, ch: '# Meeting'.length },
				{ line: 4, ch: 10 },
				['# Meeting', '', ...TWO_LINES],
			),
		);

		expect(context).toMatchObject({ line: 2, lastLine: 4, from: 0 });
	});

	it('does not resolve a selection over several lines that holds text on one', () => {
		expect(
			transcriptSelectionIn(
				createServices(),
				editorSelecting(
					{ line: 0, ch: 35 },
					{ line: 2, ch: 0 },
					TWO_LINES,
				),
				note,
			),
		).toBeNull();
	});

	it('does not resolve a selection over several lines starting outside a transcript line', () => {
		expect(
			transcriptSelectionIn(
				createServices(),
				editorSelecting({ line: 0, ch: 0 }, { line: 2, ch: 10 }, [
					'A remark.',
					'',
					LINE,
				]),
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
	const inOneLine = (enabled = true): TranscriptSelectionContext =>
		resolved(
			editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
			enabled,
		);

	it('is offered while transcription is enabled', () => {
		expect(splitAction.isAvailable(inOneLine())).toBe(true);
	});

	it('is not offered while transcription is disabled', () => {
		expect(splitAction.isAvailable(inOneLine(false))).toBe(false);
	});

	it('is not offered on a selection over several lines', () => {
		expect(
			splitAction.isAvailable(
				resolved(
					editorSelecting(
						{ line: 0, ch: 35 },
						{ line: 2, ch: 30 },
						TWO_LINES,
					),
				),
			),
		).toBe(false);
	});

	it('opens the split dialog on the selection', () => {
		const context = inOneLine();

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

describe('the merge action', () => {
	const overTwoLines = (enabled = true): TranscriptSelectionContext =>
		resolved(
			editorSelecting(
				{ line: 0, ch: 35 },
				{ line: 2, ch: 30 },
				TWO_LINES,
			),
			enabled,
		);

	it('is offered on a selection over several lines while transcription is enabled', () => {
		expect(mergeAction.isAvailable(overTwoLines())).toBe(true);
	});

	it('is not offered while transcription is disabled', () => {
		expect(mergeAction.isAvailable(overTwoLines(false))).toBe(false);
	});

	it('is not offered on a selection inside one line', () => {
		expect(
			mergeAction.isAvailable(
				resolved(
					editorSelecting({ line: 0, ch: 35 }, { line: 0, ch: 40 }),
				),
			),
		).toBe(false);
	});

	it('is titled for the menu and the palette', () => {
		expect(mergeAction.title).toBe('Merge selected lines into one');
	});

	it('opens the merge dialog on the selection', () => {
		const context = overTwoLines();

		void mergeAction.run(context);

		expect(TranscriptMergeModal).toHaveBeenCalledWith(
			context.services.app,
			context,
			expect.objectContaining({
				sidecar: context.services.recordingSidecar,
				getSettings: context.services.getSettings,
			}),
		);
	});
});
