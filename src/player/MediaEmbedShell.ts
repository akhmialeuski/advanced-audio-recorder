/**
 * Embed component for a media file whose kind (audio vs video) is not
 * known yet. It hosts Obsidian's native embed while the content probe
 * runs and, when the probe proves the file audio-only, swaps to the
 * enhanced player IN PLACE - inside this embed's own container. The swap
 * costs one embed, not a note: previously the upgrade re-rendered the
 * whole embedding view via leaf.rebuildView(), which lagged large notes
 * for even a 5-second recording (issue #39).
 *
 * Unloading the native child stops any media it was playing - the same
 * guarantee rebuildView provided, scoped to this embed. The player's own
 * render empties the container, so the shell never touches the DOM
 * directly. When the probe finds video or an unsupported file, the shell
 * simply keeps hosting the native embed and nothing re-renders.
 * @module player/MediaEmbedShell
 */

import { Component } from 'obsidian';
import type { TFile } from 'obsidian';
import type { EmbedComponent } from '../obsidian/embedRegistry';
import type { MediaKind } from './mediaProbe';

/**
 * Hosts the native embed for a not-yet-probed media file and upgrades it
 * to the enhanced player in place once the probe confirms audio.
 */
export class MediaEmbedShell extends Component implements EmbedComponent {
	/** The embed currently shown: the native embed, then maybe the player. */
	private current: EmbedComponent;
	/** Set once torn down, so a probe settling later never swaps. */
	private disposed = false;
	/** Whether Obsidian drove this embed through loadFile (Live Preview). */
	private loadFileCalled = false;
	/** The file the last loadFile call carried, replayed after a swap. */
	private lastLoadedFile: TFile | undefined;

	/**
	 * @param native - Obsidian's own embed for the file, shown immediately
	 * @param probe - The shared media-kind probe for the file
	 * @param shouldUpgrade - Whether a probed kind warrants the enhanced
	 * player, checked when the probe settles (the toggle may have flipped)
	 * @param buildPlayer - Builds the enhanced player into the same container
	 */
	constructor(
		native: EmbedComponent,
		probe: Promise<MediaKind>,
		private readonly shouldUpgrade: (kind: MediaKind) => boolean,
		private readonly buildPlayer: () => EmbedComponent,
	) {
		super();
		this.current = native;
		this.addChild(native);
		void probe.then(
			(kind) => {
				this.upgradeWhen(kind);
			},
			() => {
				// A failed probe leaves the native embed in place, which
				// renders the file exactly as Obsidian would on its own
			},
		);
	}

	/**
	 * Obsidian's Live Preview embed lifecycle calls loadFile on the embed
	 * component; forward it to whichever embed is currently hosted and
	 * remember it so a later swap can replay it on the new child.
	 * @param file - File Obsidian asks to load (the embed's own file)
	 */
	loadFile(file?: TFile): void | Promise<void> {
		this.loadFileCalled = true;
		this.lastLoadedFile = file;
		return this.current.loadFile?.(file);
	}

	/**
	 * Marks the shell torn down so a probe that settles afterwards never
	 * builds a player into a container Obsidian has abandoned.
	 */
	override onunload(): void {
		this.disposed = true;
	}

	/**
	 * Swaps the native embed for the enhanced player when the probed kind
	 * warrants it. Unloading the native child stops any media it was
	 * playing; the player's render then owns (and empties) the container.
	 * @param kind - The probed media kind
	 */
	private upgradeWhen(kind: MediaKind): void {
		if (this.disposed || !this.shouldUpgrade(kind)) {
			return;
		}
		this.removeChild(this.current);
		const player = this.buildPlayer();
		this.current = player;
		this.addChild(player);
		if (this.loadFileCalled) {
			void player.loadFile?.(this.lastLoadedFile);
		}
	}
}
