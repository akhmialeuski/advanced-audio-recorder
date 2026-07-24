/**
 * Shared doubles for the pop-out window integration suites: a Component-based
 * plugin that records its post-processor and window callbacks, an app double
 * the registrar and context menu read from, and a second-document factory.
 * Extracted so the timecode and context-menu pop-out suites drive the same
 * real primitive and registrar wiring instead of each rebuilding the fakes.
 * @module tests/helpers/popoutHarness
 */

import {
	Component,
	MarkdownView,
	TFile,
	addObsidianDomExtensions,
} from 'obsidian';
import type { App, MarkdownPostProcessor, WorkspaceLeaf } from 'obsidian';

/** A pop-out-like window handle, as workspace window events carry it. */
export interface WindowLike {
	doc: Document;
}

/**
 * A plugin double built on the real Component (so addChild/removeChild and
 * registerDomEvent attach and detach listeners for real), exposing the
 * post-processor, the workspace window callbacks, and the open leaves the
 * pop-out suites drive.
 */
export class FakePlugin extends Component {
	readonly postProcessors: MarkdownPostProcessor[] = [];
	readonly windowListeners: Record<string, (win: WindowLike) => void> = {};
	/** Leaves the app double iterates; suites push to it to model open views. */
	readonly leaves: WorkspaceLeaf[] = [];
	app!: App;

	registerMarkdownPostProcessor(
		processor: MarkdownPostProcessor,
	): MarkdownPostProcessor {
		this.postProcessors.push(processor);
		return processor;
	}

	/** Fires a recorded workspace window event, as Obsidian would. */
	emit(name: 'window-open' | 'window-close', doc: Document): void {
		this.windowListeners[name]?.({ doc });
	}
}

/**
 * The audio file every embed and link in these suites resolves to. Built on
 * the TFile prototype so the registrar's and context menu's `instanceof TFile`
 * guards pass.
 */
export function makeFile(): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path: 'rec.mp4',
		basename: 'rec',
		extension: 'mp4',
		stat: { mtime: 1, size: 1000 },
	}) as TFile;
}

/** A fresh, independent document standing in for a pop-out window. */
export function makePopoutDoc(): Document {
	return document.implementation.createHTMLDocument('popout');
}

/**
 * Builds the app double the registrar, player, and context menu read from.
 * `iterateAllLeaves` walks the plugin's `leaves`, so a suite can register an
 * open view after setup, and `on` records the window callbacks onto the plugin
 * so a suite can fire window-open/window-close.
 * @param plugin - The plugin double whose leaves and window callbacks are used
 * @param file - The audio file link resolution returns
 */
export function makeApp(plugin: FakePlugin, file: TFile): App {
	return {
		vault: {
			getResourcePath: () => 'app://media',
			readBinary: () => Promise.resolve(new ArrayBuffer(0)),
			getFileByPath: () => file,
			delete: jest.fn(),
			on: () => ({}),
		},
		fileManager: {
			trashFile: jest.fn(),
			generateMarkdownLink: () => '[[rec.mp4]]',
		},
		metadataCache: {
			getFirstLinkpathDest: (linkPath: string) =>
				linkPath.startsWith('rec') ? file : null,
		},
		workspace: {
			getActiveFile: () => ({ path: 'note.md' }),
			getActiveViewOfType: () => null,
			getLeavesOfType: () => [] as WorkspaceLeaf[],
			iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void) =>
				plugin.leaves.forEach(cb),
			trigger: jest.fn(),
			on: (name: string, cb: (win: WindowLike) => void) => {
				plugin.windowListeners[name] = cb;
				return {};
			},
		},
	} as unknown as App;
}

/** A popped-out note in Live Preview, wired for a timecode-link click. */
export interface PopoutLivePreview {
	/** The CodeMirror internal-link token to dispatch the click on. */
	linkToken: HTMLElement;
	/** The element the registrar's post-processor enhances into a player. */
	embedHost: HTMLElement;
	/** The audio embed the player mounts into (its time display is asserted). */
	embed: HTMLElement;
}

/**
 * Builds a popped-out note in Live Preview: a real MarkdownView (so the
 * owning-view lookup matches it via `instanceof`) whose container lives in the
 * pop-out document and holds both a CodeMirror internal-link token and an audio
 * embed, and whose editor resolves the wikilink from source. The view is
 * registered as an open leaf so `markdownViewContaining` finds it. jsdom has no
 * real CodeMirror, so the editor's `posAtDOM`/`offsetToPos`/`getLine` are
 * stubbed to map the click onto the wikilink in the source line, exactly as the
 * main-window Live Preview unit test does.
 * @param plugin - The plugin whose leaves the app double iterates
 * @param doc - The pop-out document the note is rendered in
 * @param notePath - The popped-out note's path (its link source path)
 * @param sourceLine - The editor line the timecode wikilink is read from
 * @returns The link token to click and the embed the player mounts into
 */
export function makePopoutLivePreview(
	plugin: FakePlugin,
	doc: Document,
	notePath: string,
	sourceLine: string,
): PopoutLivePreview {
	const container = doc.createElement('div');
	doc.body.appendChild(container);

	const linkToken = doc.createElement('span');
	linkToken.className = 'cm-hmd-internal-link';
	linkToken.textContent = '1:30';
	container.appendChild(linkToken);

	const embedHost = addObsidianDomExtensions(doc.createElement('div'));
	const embed = addObsidianDomExtensions(doc.createElement('div'));
	embed.className = 'internal-embed is-loaded';
	embed.setAttribute('src', 'rec.mp4');
	embedHost.appendChild(embed);
	container.appendChild(embedHost);

	const editor = {
		cm: { posAtDOM: () => 5 },
		offsetToPos: () => ({ line: 0, ch: 5 }),
		getLine: () => sourceLine,
	};
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		containerEl: container,
		file: { path: notePath },
		editor,
	}) as MarkdownView;
	plugin.leaves.push({
		view,
		getContainer: () => ({ doc }),
	} as unknown as WorkspaceLeaf);

	return { linkToken, embedHost, embed };
}
