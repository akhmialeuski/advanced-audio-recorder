/**
 * Tests for the internal embed-registry adapter: availability detection,
 * creator override, previous-creator capture, and restoration.
 */

import type { App } from 'obsidian';
import {
	getEmbedRegistry,
	EmbedRegistryOverride,
	type EmbedRegistry,
	type EmbedCreator,
} from 'src/obsidian/embedRegistry';

/** Builds a uniquely identifiable creator stub. */
function creator(tag: string): EmbedCreator {
	return () => ({ tag });
}

/** Builds a mock registry backed by an in-memory map. */
function makeRegistry(
	initial: Record<string, EmbedCreator> = {},
): EmbedRegistry & { embedByExtension: Record<string, EmbedCreator> } {
	const embedByExtension: Record<string, EmbedCreator> = { ...initial };
	return {
		embedByExtension,
		registerExtensions(exts: string[], c: EmbedCreator): void {
			for (const e of exts) {
				embedByExtension[e] = c;
			}
		},
		unregisterExtensions(exts: string[]): void {
			for (const e of exts) {
				delete embedByExtension[e];
			}
		},
	};
}

describe('getEmbedRegistry', () => {
	it('returns the registry when present', () => {
		const reg = makeRegistry();
		const app = { embedRegistry: reg } as unknown as App;
		expect(getEmbedRegistry(app)).toBe(reg);
	});

	it('returns null when absent', () => {
		expect(getEmbedRegistry({})).toBeNull();
	});
});

describe('EmbedRegistryOverride.isAvailable', () => {
	it('accepts a registry with a map and a register method', () => {
		expect(EmbedRegistryOverride.isAvailable(makeRegistry())).toBe(true);
	});

	it('rejects null and incomplete registries', () => {
		expect(EmbedRegistryOverride.isAvailable(null)).toBe(false);
		expect(EmbedRegistryOverride.isAvailable({} as EmbedRegistry)).toBe(
			false,
		);
		expect(
			EmbedRegistryOverride.isAvailable({
				embedByExtension: {},
			} as EmbedRegistry),
		).toBe(false);
	});
});

describe('EmbedRegistryOverride override/restore', () => {
	it('overrides creators and restores the originals', () => {
		const original = creator('default-mp3');
		const reg = makeRegistry({ mp3: original });
		const ours = creator('ours');
		const override = new EmbedRegistryOverride(reg);

		override.override(['mp3', 'mp4'], ours);
		expect(reg.embedByExtension.mp3).toBe(ours);
		expect(reg.embedByExtension.mp4).toBe(ours);
		expect(override.getPrevious('mp3')).toBe(original);
		expect(override.getPrevious('mp4')).toBeUndefined();

		override.restore();
		expect(reg.embedByExtension.mp3).toBe(original);
		expect('mp4' in reg.embedByExtension).toBe(false);
	});

	it('falls back to registerExtension (singular) when plural is absent', () => {
		const embedByExtension: Record<string, EmbedCreator> = {};
		const reg: EmbedRegistry = {
			embedByExtension,
			registerExtension(ext: string, c: EmbedCreator): void {
				embedByExtension[ext] = c;
			},
		};
		const ours = creator('ours');
		const override = new EmbedRegistryOverride(reg);

		override.override(['wav'], ours);
		expect(embedByExtension.wav).toBe(ours);

		override.restore();
		expect('wav' in embedByExtension).toBe(false);
	});

	it('is safe to restore more than once', () => {
		const reg = makeRegistry({ mp3: creator('default') });
		const override = new EmbedRegistryOverride(reg);
		override.override(['mp3'], creator('ours'));
		override.restore();
		expect(() => {
			override.restore();
		}).not.toThrow();
	});
});
