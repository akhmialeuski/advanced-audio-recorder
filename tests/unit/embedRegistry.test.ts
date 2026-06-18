/**
 * Tests for the internal embed-registry adapter: availability detection,
 * creator override (direct map assignment), previous-creator capture,
 * and restoration.
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

/** Builds a mock registry backed by an in-memory extension map. */
function makeRegistry(
	initial: Record<string, EmbedCreator> = {},
): EmbedRegistry & { embedByExtension: Record<string, EmbedCreator> } {
	return { embedByExtension: { ...initial } };
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
	it('accepts a registry exposing the extension map', () => {
		expect(EmbedRegistryOverride.isAvailable(makeRegistry())).toBe(true);
		expect(
			EmbedRegistryOverride.isAvailable({ embedByExtension: {} }),
		).toBe(true);
	});

	it('rejects null or a registry without the map', () => {
		expect(EmbedRegistryOverride.isAvailable(null)).toBe(false);
		expect(EmbedRegistryOverride.isAvailable({})).toBe(false);
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
