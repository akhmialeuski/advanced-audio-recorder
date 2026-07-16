/**
 * The single place that asks Obsidian which platform the plugin runs on.
 * Everything above this module reasons in terms of a {@link PlatformKind}
 * (or, higher still, of the capability functions in ./capabilities) and
 * never touches `Platform` directly, so platform-specific behavior stays
 * decided in one low-level layer.
 * @module platform/platformKind
 */

import { Platform } from 'obsidian';

/** The two platform families the plugin distinguishes. */
export type PlatformKind = 'desktop' | 'mobile';

/** Every platform kind, for iteration (settings branches, tests). */
export const PLATFORM_KINDS: readonly PlatformKind[] = ['desktop', 'mobile'];

/**
 * Resolves the platform the plugin is currently running on. Read lazily
 * on every call (not cached at module load) so the value follows
 * Obsidian's `Platform` flags wherever they are evaluated.
 * @returns The current platform kind
 */
export function getPlatformKind(): PlatformKind {
	return Platform.isMobileApp || Platform.isMobile ? 'mobile' : 'desktop';
}

/**
 * Whether the plugin runs in the mobile app.
 * @returns True on mobile
 */
export function isMobilePlatform(): boolean {
	return getPlatformKind() === 'mobile';
}

/**
 * Normalizes an untrusted value (e.g. a key read from data.json) to a
 * platform kind, or null when it names no known platform.
 * @param value - Candidate platform key
 * @returns The platform kind, or null for unknown values
 */
export function normalizePlatformKind(value: unknown): PlatformKind | null {
	return value === 'desktop' || value === 'mobile' ? value : null;
}
