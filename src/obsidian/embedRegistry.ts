/**
 * Isolated adapter for Obsidian's internal embed registry. The registry
 * lets a plugin register a custom embed component per file extension, so
 * Obsidian itself creates our player instead of its default audio/video
 * embed — covering both Reading view and Live Preview without racing the
 * DOM. This API is undocumented and absent from the public obsidian.d.ts,
 * so every access goes through this module: the types live here, the
 * shape is probed defensively at runtime, and the original creators are
 * captured so they can be restored on unload. Nothing else in the
 * codebase touches the internal API directly.
 * @module obsidian/embedRegistry
 */

import type { App, Component, TFile } from 'obsidian';

/**
 * Context Obsidian passes to an embed creator. Only the fields the player
 * needs are typed; the rest of the (internal) shape is left open.
 */
export interface EmbedInfo {
	/** Element the embed must render into. */
	containerEl: HTMLElement;
	/** Vault path of the note hosting the embed, when provided. */
	sourcePath?: string;
	[key: string]: unknown;
}

/**
 * Minimal contract an embed component exposes to Obsidian. Obsidian
 * manages its lifecycle (load/unload) through the render tree.
 */
export interface EmbedComponent extends Component {
	/** Obsidian may call this after creation to (re)load the file. */
	loadFile?(file?: TFile): void | Promise<void>;
}

/** Factory Obsidian calls to create an embed for a file. */
export type EmbedCreator = (
	info: EmbedInfo,
	file: TFile,
	subpath: string,
) => EmbedComponent;

/**
 * Internal embed registry shape. Only the `embedByExtension` lookup map
 * is used: overriding and restoring creators is done by writing it
 * directly. Obsidian's registerExtension(s) methods are deliberately not
 * called because they throw on extensions that are already registered
 * (every media extension is), which would abort plugin load. The member
 * is optional so the runtime guard can detect a removed/changed API.
 */
export interface EmbedRegistry {
	embedByExtension?: Record<string, EmbedCreator>;
}

declare module 'obsidian' {
	interface App {
		embedRegistry?: EmbedRegistry;
	}
}

/**
 * Returns Obsidian's embed registry, or null when the internal API is
 * absent (e.g. a future version removed or renamed it).
 * @param app - Obsidian App instance
 */
export function getEmbedRegistry(app: App): EmbedRegistry | null {
	return app.embedRegistry ?? null;
}

/**
 * Overrides the embed creators for a set of extensions and restores the
 * originals on teardown. Registration writes the embedByExtension map
 * directly — registerExtension(s) is deliberately not used because it throws
 * on extensions that are already registered (every media extension is).
 * Restoration always rewrites the map so the plugin never leaves a dangling
 * override after unload.
 */
export class EmbedRegistryOverride {
	private readonly previous = new Map<string, EmbedCreator | undefined>();
	private extensions: string[] = [];
	private active = false;

	/**
	 * @param registry - The internal embed registry to override
	 */
	constructor(private readonly registry: EmbedRegistry) {}

	/**
	 * Reports whether a registry exposes the extension map needed to
	 * override and restore creators safely.
	 * @param registry - Candidate registry (may be null)
	 */
	static isAvailable(
		registry: EmbedRegistry | null,
	): registry is EmbedRegistry {
		return (
			registry !== null &&
			typeof registry.embedByExtension === 'object' &&
			registry.embedByExtension !== null
		);
	}

	/**
	 * Captures the current creators for the given extensions and installs
	 * the replacement by writing the lookup map directly. Direct
	 * assignment is intentional: registerExtensions throws on
	 * already-registered extensions, and this mirrors what restore()
	 * reverses.
	 * @param extensions - File extensions to take over
	 * @param creator - Replacement embed creator
	 */
	override(extensions: string[], creator: EmbedCreator): void {
		const map = this.registry.embedByExtension;
		if (!map) {
			return;
		}
		this.extensions = [...extensions];
		for (const ext of extensions) {
			this.previous.set(ext, map[ext]);
			map[ext] = creator;
		}
		this.active = true;
	}

	/**
	 * Returns the creator that was registered for an extension before the
	 * override, so the caller can delegate to Obsidian's default.
	 * @param extension - File extension
	 */
	getPrevious(extension: string): EmbedCreator | undefined {
		return this.previous.get(extension);
	}

	/**
	 * Restores the captured creators, removing the override entirely. Safe
	 * to call more than once.
	 */
	restore(): void {
		if (!this.active) {
			return;
		}
		const map = this.registry.embedByExtension;
		if (map) {
			for (const ext of this.extensions) {
				const original = this.previous.get(ext);
				if (original) {
					map[ext] = original;
				} else {
					delete map[ext];
				}
			}
		}
		this.previous.clear();
		this.extensions = [];
		this.active = false;
	}
}
