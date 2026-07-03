/**
 * Small object-shape helpers shared across layers.
 * @module utils/objects
 */

/**
 * Narrows an unknown value to a plain record so its properties can be
 * accessed without unchecked casts.
 * @param value - Value to test
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
