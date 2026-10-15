/**
 * Contract tests for the `editorInfoField` double.
 *
 * Code that maps a rendered node back to its editor reads this field from a
 * real CodeMirror view, so the double has to be a real state field that a
 * view can be seeded with, and has to read as absent when it was not.
 * @module tests/unit/mocks/obsidianEditorInfoField.test
 */

import { EditorState } from '@codemirror/state';
import { editorInfoField, TFile } from '../../mocks/obsidian';

describe('editorInfoField', () => {
	it('hands back the info a view was seeded with', () => {
		const info = { file: new TFile('Notes/a.md'), editor: {} };
		const state = EditorState.create({
			extensions: [editorInfoField.init(() => info)],
		});

		expect(state.field(editorInfoField, false)).toBe(info);
	});

	it('is absent from a view built without it', () => {
		const state = EditorState.create({});

		expect(state.field(editorInfoField, false)).toBeUndefined();
	});

	it('holds null in a view that includes it unseeded', () => {
		const state = EditorState.create({ extensions: [editorInfoField] });

		expect(state.field(editorInfoField)).toBeNull();
	});

	it('keeps its info across an edit', () => {
		const info = { file: null };
		const state = EditorState.create({
			doc: 'a',
			extensions: [editorInfoField.init(() => info)],
		});

		const next = state.update({ changes: { from: 1, insert: 'b' } }).state;

		expect(next.field(editorInfoField)).toBe(info);
	});
});
