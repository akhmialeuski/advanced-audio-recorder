/**
 * A timecode link clicked in a note, followed through the real components to
 * what the user sees: the registrar's own click handler, the AudioPlayer it
 * mounted for the recording's embed, and the registry publishing to the
 * status bar, all on one shared audio element.
 *
 * The registrar's own suite mocks the player and stubs the registry's seek,
 * and the playback-sync suite seeks the registry directly, so neither proves
 * that a click lands on the embed the user is looking at. Reading view and
 * Live Preview reach the link through different DOM - a rendered
 * `a.internal-link` against an editor token read back from the note source -
 * so each is clicked here. The recording's name holds a space, and only that
 * exact name resolves to a file, so a link split or decoded wrongly finds
 * nothing and the time display stays where it was.
 * @jest-environment jsdom
 */

import type { App, Component, TFile } from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import type { EmbedInfo } from 'src/obsidian/embedRegistry';
import type { MediaKindStore } from 'src/player/MediaKindStore';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { createMockApp } from '../helpers/createApp';
import { fileAt, partialPlugin } from '../helpers/obsidianMock';
import { partial } from '../helpers/doubles';
import { at } from '../helpers/assertions';
import { mountLiveEditor, rangeOf } from '../helpers/liveEditor';
import {
	installSharedAudio,
	makeMarkerStore,
	makePlayerContainer,
	timeText,
	tick,
} from '../helpers/playbackHarness';

/** The recording, named with a space so a Markdown link has to encode it. */
const RECORDING = 'rec one.mp4';

/** Everything a case clicks against, mounted and ready. */
interface Sut {
	/** The embedded player's container. */
	container: HTMLElement;
	/** The latest playback the status bar was pushed. */
	snapshot: () => PlaybackControlsState | null;
	/** The note the links are written in. */
	note: TFile;
}

/** Teardown for whatever a case installed, drained after each. */
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
	document.body.innerHTML = '';
});

/**
 * Registers the real registrar over a vault holding the recording, mounts the
 * player its embed creator builds for it, and parks playback at the start of
 * a ten-minute file.
 * @returns The player's container, the status-bar reader and the note
 */
async function mountedEmbed(): Promise<Sut> {
	const shared = installSharedAudio();
	cleanups.push(shared.restore);
	const recording = fileAt(RECORDING);
	const note = fileAt('note.md');
	const embedByExtension: Record<string, unknown> = { mp4: jest.fn() };
	const app: App = createMockApp({
		embedRegistry: { embedByExtension },
		vault: {
			getResourcePath: () => 'app://media',
			readBinary: () => Promise.resolve(new ArrayBuffer(0)),
			on: jest.fn(() => ({})),
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [] }),
			// Only the exact name resolves, as in a vault with one recording:
			// a target still carrying its subpath or its %20 finds nothing.
			getFirstLinkpathDest: (linkPath: string) =>
				linkPath === RECORDING ? recording : null,
		},
		workspace: {
			getActiveFile: () => note,
			getLeavesOfType: () => [],
			iterateAllLeaves: jest.fn(),
		},
	}).app;
	// What the registrar registers on load. A child is loaded as Obsidian
	// loads one added to a loaded plugin, which is what puts the timecode
	// click listener on the document, and unloaded with the plugin when the
	// case ends, so no case's listener answers the next case's click.
	const plugin = partialPlugin({
		registerMarkdownPostProcessor: jest.fn(),
		registerEvent: jest.fn(),
		addChild: <T extends Component>(child: T): T => {
			child.load();
			cleanups.push(() => {
				child.unload();
			});
			return child;
		},
		removeChild: jest.fn(),
	});
	const registrar = new EnhancedPlayerRegistrar(
		plugin,
		app,
		// No waveform: drawing one decodes the file, which jsdom cannot.
		() => ({
			...DEFAULT_SETTINGS,
			enhancedPlayerEnabled: true,
			playerShowWaveform: false,
		}),
		makeMarkerStore(),
		// Probed as audio in an earlier session, so the embed creator builds
		// the enhanced player at once instead of probing the file.
		partial<MediaKindStore>({
			load: () => Promise.resolve(),
			get: () => 'audio',
			set: jest.fn(),
			handleRename: jest.fn(),
			handleDelete: jest.fn(),
			flush: jest.fn(),
		}),
	);
	registrar.register();
	cleanups.push(() => {
		registrar.dispose();
	});
	let latest: PlaybackControlsState | null = null;
	registrar.subscribePlayback((state) => {
		latest = state;
	});

	const container = makePlayerContainer();
	const create = embedByExtension['mp4'] as (
		info: EmbedInfo,
		file: TFile,
		subpath: string,
	) => { load(): void };
	create(
		partial<EmbedInfo>({ containerEl: container, sourcePath: 'note.md' }),
		recording,
		'',
	).load();
	await tick();
	shared.audio.setReady(1);
	shared.audio.setDuration(600);
	return { container, snapshot: () => latest, note };
}

/**
 * Clicks an element the way the user does, so the event reaches the
 * registrar's capture listener on the document.
 * @param target - The element clicked
 */
function click(target: HTMLElement): void {
	target.dispatchEvent(
		new MouseEvent('click', { bubbles: true, cancelable: true }),
	);
}

/**
 * Clicks the link token of a Live Preview line, a real CodeMirror editor
 * showing the note.
 * @param note - The note the editor shows
 * @param line - The note's source
 * @param token - The text Live Preview marks as the link
 */
function clickLivePreview(note: TFile, line: string, token: string): void {
	const live = mountLiveEditor({
		doc: line,
		file: note,
		linkTokens: [rangeOf(line, token)],
	});
	click(at(live.linkTokens(), 0));
}

describe('a timecode link clicked in a note', () => {
	it('moves the embed and the status bar in Reading view', async () => {
		const { container, snapshot } = await mountedEmbed();
		const anchor = document.createElement('a');
		anchor.className = 'internal-link';
		anchor.setAttribute('data-href', `${RECORDING}#t=30`);
		document.body.append(anchor);

		click(anchor);

		expect(timeText(container)).toBe('0:30 / 10:00');
		expect(snapshot()).toEqual(
			expect.objectContaining({ currentTime: 30, duration: 600 }),
		);
	});

	it('moves the embed and the status bar for a wikilink in Live Preview', async () => {
		const { container, snapshot, note } = await mountedEmbed();

		clickLivePreview(
			note,
			`[[${RECORDING}#t=45|0:45]] Speaker 1`,
			`${RECORDING}#t=45|0:45`,
		);

		expect(timeText(container)).toBe('0:45 / 10:00');
		expect(snapshot()).toEqual(
			expect.objectContaining({ currentTime: 45, duration: 600 }),
		);
	});

	it('decodes a Markdown link to the recording in Live Preview', async () => {
		const { container, snapshot, note } = await mountedEmbed();

		clickLivePreview(note, '[0:50](rec%20one.mp4#t=50) Speaker 1', '0:50');

		expect(timeText(container)).toBe('0:50 / 10:00');
		expect(snapshot()).toEqual(
			expect.objectContaining({ currentTime: 50, duration: 600 }),
		);
	});
});
