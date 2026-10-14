/**
 * Tests for the lookup from a node an editor rendered to that editor and the
 * source position the node stands for. They run against a real CodeMirror
 * editor, so the mapping under test is CodeMirror's own.
 */

import type { TFile } from 'obsidian';
import { editorPositionOfNode } from 'src/obsidian/editorDomPosition';
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';
import { makePopoutDoc } from '../helpers/popoutHarness';
import { mountLiveEditor, rangeOf } from '../helpers/liveEditor';

const NOTE = 'Intro\nSee ![[rec.m4a]] and [[rec.m4a#t=5|0:05]]';

/**
 * A note in Live Preview with its embed rendered as a widget and its timecode
 * link as an internal-link token.
 * @param options - Where to mount it, and whether Obsidian owns the editor
 * @returns The mounted note and the file it shows
 */
function createSut(
	options: { parent?: HTMLElement; owned?: boolean } = {},
): ReturnType<typeof mountLiveEditor> & { note: TFile } {
	const note = partial<TFile>({ path: 'Notes/meeting.md' });
	const live = mountLiveEditor({
		doc: NOTE,
		file: note,
		embeds: [{ ...rangeOf(NOTE, '![[rec.m4a]]'), src: 'rec.m4a' }],
		linkTokens: [rangeOf(NOTE, 'rec.m4a#t=5|0:05')],
		...options,
	});
	return { ...live, note };
}

describe('editorPositionOfNode', () => {
	it('maps an embed widget to where its source starts', () => {
		const { embeds } = createSut();

		const rendered = editorPositionOfNode(at(embeds(), 0));

		expect(rendered?.position).toEqual({ line: 1, ch: 4 });
	});

	it('maps a link token to the start of the text it covers', () => {
		const { linkTokens } = createSut();

		const rendered = editorPositionOfNode(at(linkTokens(), 0));

		expect(rendered?.position).toEqual({ line: 1, ch: 23 });
	});

	it('names what Obsidian bound to the view the node belongs to', () => {
		const { embeds, editor, note } = createSut();

		const rendered = editorPositionOfNode(at(embeds(), 0));

		expect(rendered).toMatchObject({ editor, file: note });
	});

	it('finds the editor of a pop-out window from its own document', () => {
		const popoutDoc = makePopoutDoc();
		const parent = popoutDoc.body.appendChild(
			popoutDoc.createElement('div'),
		);
		const { embeds, editor } = createSut({ parent });

		const rendered = editorPositionOfNode(at(embeds(), 0));

		expect(rendered?.editor).toBe(editor);
	});

	it('answers nothing for a node no editor rendered', () => {
		const node = document.body.appendChild(document.createElement('div'));

		expect(editorPositionOfNode(node)).toBeNull();
	});

	it('answers nothing for a node in the editor but outside its content', () => {
		const { view } = createSut();
		const panel = view.dom.appendChild(document.createElement('div'));

		expect(editorPositionOfNode(panel)).toBeNull();
	});

	it('answers nothing in an editor Obsidian does not own', () => {
		const { embeds } = createSut({ owned: false });

		expect(editorPositionOfNode(at(embeds(), 0))).toBeNull();
	});
});
