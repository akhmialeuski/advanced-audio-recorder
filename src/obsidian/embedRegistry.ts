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
 * Internal embed registry shape. Every member is optional so the runtime
 * guard can detect an incompatible or removed API instead of crashing.
 */
export interface EmbedRegistry {
	embedByExtension?: Record<string, EmbedCreator>;
	registerExtension?(extension: string, creator: EmbedCreator): void;
	registerExtensions?(extensions: string[], creator: EmbedCreator): void;
	unregisterExtension?(extension: string): void;
	unregisterExtensions?(extensions: string[]): void;
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
 * originals on teardown. Registration prefers the public-ish
 * registerExtension(s) methods and falls back to writing the
 * embedByExtension map directly; restoration always rewrites the map so
 * the plugin never leaves a dangling override after unload.
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
	 * Reports whether a registry exposes enough of the internal API to
	 * override and restore creators safely.
	 * @param registry - Candidate registry (may be null)
	 */
	static isAvailable(
		registry: EmbedRegistry | null,
	): registry is EmbedRegistry {
		return (
			registry !== null &&
			typeof registry.embedByExtension === 'object' &&
			registry.embedByExtension !== null &&
			(typeof registry.registerExtension === 'function' ||
				typeof registry.registerExtensions === 'function')
		);
	}

	/**
	 * Captures the current creators for the given extensions and installs
	 * the replacement.
	 * @param extensions - File extensions to take over
	 * @param creator - Replacement embed creator
	 */
	override(extensions: string[], creator: EmbedCreator): void {
		this.extensions = [...extensions];
		for (const ext of extensions) {
			this.previous.set(ext, this.registry.embedByExtension?.[ext]);
		}
		if (typeof this.registry.registerExtensions === 'function') {
			this.registry.registerExtensions(extensions, creator);
		} else if (typeof this.registry.registerExtension === 'function') {
			for (const ext of extensions) {
				this.registry.registerExtension(ext, creator);
			}
		} else if (this.registry.embedByExtension) {
			for (const ext of extensions) {
				this.registry.embedByExtension[ext] = creator;
			}
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
