/**
 * Small defensive helpers shared by the provider response mappers for
 * parsing untrusted JSON. Centralized so a fix to the narrowing (e.g.
 * excluding arrays) applies to every mapper instead of drifting per file.
 * @module transcription/providers/responseUtils
 */

import type { TranscriptionUsage } from '../TranscriptTypes';

/**
 * Narrows an unknown value to a plain (non-array) object record. Arrays are
 * excluded so callers can index `[0]` only after an explicit `Array.isArray`
 * check, keeping object and array handling distinct.
 * @param value - Value to test
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerces an unknown value to a finite number, or returns the fallback.
 * @param value - Value to coerce
 * @param fallback - Value returned when `value` is not a finite number
 */
export function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: fallback;
}

/**
 * Reads the billed audio duration a response carries, in seconds, so the
 * run's actual cost can be computed. One rule for every engine that reports
 * a duration: a finite number that is not negative.
 * @param value - The field the engine reports its billed duration in
 * @returns The usage, or undefined when the field carries no duration
 */
export function billedSeconds(value: unknown): TranscriptionUsage | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return { audioSeconds: value };
}
