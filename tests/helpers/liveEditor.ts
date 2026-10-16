/**
 * A note open in Live Preview, built on a real CodeMirror editor.
 *
 * CodeMirror runs in jsdom, so the DOM-to-source mapping the plugin relies on
 * (`EditorView.findFromDOM`, `posAtDOM`) runs for real here instead of through
 * a stubbed `posAtDOM` returning whatever the test wanted. What Obsidian adds
 * on top is modelled thinly: its `editorInfoField` is seeded with the Obsidian
 * `Editor` and note the view belongs to, embeds are rendered as replace
 * widgets carrying `.internal-embed[src]`, and a wikilink can be marked as the
 * `.cm-hmd-internal-link` token Live Preview renders it as.
 *
 * Every editor mounted in a test is destroyed after it, so no view outlives
 * the test that built it.
 * @module tests/helpers/liveEditor
 */

import { EditorState, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { Editor, EditorPosition, MarkdownFileInfo, TFile } from 'obsidian';
import { partial } from './doubles';

/** Views mounted by the current test, destroyed when it ends. */
const mounted: EditorView[] = [];

afterEach(() => {
	for (const view of mounted.splice(0)) {
		view.destroy();
	}
});

/** A source range rendered as an audio embed widget. */
export interface EmbedRange {
	/** Offset the embed's source starts at (its `!`). */
	from: number;
	/** Offset just past the embed's closing bracket. */
	to: number;
	/** The link text the widget carries in `src`, as Obsidian sets it. */
	src: string;
}

/** What a Live Preview note is built from. */
export interface LiveEditorOptions {
	/** The note's source. */
	doc: string;
	/** The note the editor shows; null for an editor bound to no file. */
	file?: TFile | null;
	/** Where to mount the editor; a fresh element in `document` by default. */
	parent?: HTMLElement;
	/** Source ranges rendered as embed widgets. */
	embeds?: EmbedRange[];
	/** Source ranges marked as Live Preview's internal-link token. */
	linkTokens?: Array<{ from: number; to: number }>;
	/**
	 * Whether Obsidian owns the editor and seeded its editor info. Off, the
	 * view is a bare CodeMirror editor, such as another plugin's.
	 */
	owned?: boolean;
}

/** A mounted Live Preview note. */
export interface LiveEditor {
	/** The CodeMirror view. */
	view: EditorView;
	/** The Obsidian editor over it; `replaceRange` is spied. */
	editor: Editor & { replaceRange: jest.Mock };
	/** The element the editor was mounted into. */
	parent: HTMLElement;
	/** The rendered embed widgets, in source order. */
	embeds: () => HTMLElement[];
	/** The rendered internal-link tokens, in source order. */
	linkTokens: () => HTMLElement[];
	/** The note's source as the editor holds it now. */
	text: () => string;
}

/** The widget Live Preview renders an embed's source range as. */
class EmbedWidget extends WidgetType {
	constructor(private readonly src: string) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.createElement('div');
		el.className = 'internal-embed';
		el.setAttribute('src', this.src);
		return el;
	}
}

/**
 * The decorations Live Preview would draw for the given options.
 * @param options - The embeds and link tokens to draw
 * @returns A state field providing them
 */
function liveDecorations(
	options: LiveEditorOptions,
): StateField<DecorationSet> {
	const ranges = [
		...(options.embeds ?? []).map((embed) =>
			Decoration.replace({ widget: new EmbedWidget(embed.src) }).range(
				embed.from,
				embed.to,
			),
		),
		...(options.linkTokens ?? []).map((token) =>
			Decoration.mark({ class: 'cm-hmd-internal-link' }).range(
				token.from,
				token.to,
			),
		),
	];
	return StateField.define<DecorationSet>({
		create: () => Decoration.set(ranges, true),
		update: (value, transaction) => value.map(transaction.changes),
		provide: (field) => EditorView.decorations.from(field),
	});
}

/**
 * Builds the Obsidian editor over a CodeMirror view: the methods the plugin
 * calls, each answered from the view's own document.
 * @param view - The CodeMirror view
 * @returns The editor
 */
function obsidianEditorOver(
	view: EditorView,
): Editor & { replaceRange: jest.Mock } {
	const offsetToPos = (offset: number): EditorPosition => {
		const line = view.state.doc.lineAt(offset);
		return { line: line.number - 1, ch: offset - line.from };
	};
	const posToOffset = (pos: EditorPosition): number =>
		view.state.doc.line(pos.line + 1).from + pos.ch;
	const editor = partial<Editor>({
		getLine: (line: number) => view.state.doc.line(line + 1).text,
		offsetToPos,
		posToOffset,
		getCursor: () => offsetToPos(view.state.selection.main.head),
		somethingSelected: () => !view.state.selection.main.empty,
		setCursor: (pos: EditorPosition | number) => {
			const offset = typeof pos === 'number' ? pos : posToOffset(pos);
			view.dispatch({ selection: { anchor: offset } });
		},
	});
	const replaceRange = jest.fn(
		(text: string, from: EditorPosition, to?: EditorPosition): void => {
			view.dispatch({
				changes: {
					from: posToOffset(from),
					to: posToOffset(to ?? from),
					insert: text,
				},
			});
		},
	);
	return Object.assign(editor, { replaceRange });
}

/**
 * Mounts a Live Preview note on a real CodeMirror editor.
 * @param options - The note's source, file, and what to render over it
 * @returns The mounted note
 */
export function mountLiveEditor(options: LiveEditorOptions): LiveEditor {
	const parent = options.parent ?? document.createElement('div');
	if (!parent.isConnected) {
		document.body.appendChild(parent);
	}
	let editor: (Editor & { replaceRange: jest.Mock }) | null = null;
	const info = partial<MarkdownFileInfo>({
		get file() {
			return options.file ?? null;
		},
		get editor() {
			return editor ?? undefined;
		},
	});
	const view = new EditorView({
		state: EditorState.create({
			doc: options.doc,
			extensions: [
				liveDecorations(options),
				...(options.owned === false
					? []
					: [editorInfoField.init(() => info)]),
			],
		}),
		parent,
	});
	mounted.push(view);
	editor = obsidianEditorOver(view);
	return {
		view,
		editor,
		parent,
		embeds: () => [
			...view.contentDOM.querySelectorAll<HTMLElement>('.internal-embed'),
		],
		linkTokens: () => [
			...view.contentDOM.querySelectorAll<HTMLElement>(
				'.cm-hmd-internal-link',
			),
		],
		text: () => view.state.doc.toString(),
	};
}

/**
 * Where a substring of a note's source starts and ends, for building the
 * ranges a note is rendered with.
 * @param doc - The note's source
 * @param needle - Text that occurs in it
 * @returns The range the first occurrence covers
 */
export function rangeOf(
	doc: string,
	needle: string,
): { from: number; to: number } {
	const from = doc.indexOf(needle);
	if (from < 0) {
		throw new Error(`"${needle}" does not occur in the note`);
	}
	return { from, to: from + needle.length };
}
