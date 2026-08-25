/**
 * Time-related utilities shared across modules.
 * @module utils/TimeUtils
 */

import { SECONDS_PER_MINUTE, SECONDS_PER_HOUR } from '../constants';

/**
 * Delays execution for the specified number of milliseconds.
 * Uses activeWindow so the timer is attached to the active Obsidian
 * window (multi-window support).
 *
 * A wait the caller can be released from takes a signal: the retry pause
 * between provider attempts and the interval between Gemini file-status polls
 * are both waits a Cancel has to end at once rather than after they run out.
 * The rejection carries `signal.reason`, which is what the platform hands an
 * aborted `fetch`, so a caller sees one shape of cancellation whether it was
 * waiting or requesting.
 * @param ms - Delay duration in milliseconds
 * @param signal - Optional abort signal; firing it rejects the wait
 * @returns Promise resolved after the delay
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			window.clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = window.setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** A deadline that grows with the size of the payload it covers. */
export interface ScaledTimeoutBudget {
	/** Deadline for an empty payload, and the floor for every other one. */
	readonly floorMs: number;
	/** Bytes assumed to be handled per millisecond above the floor. */
	readonly bytesPerMs: number;
	/** Hard cap, whatever the payload size works out to. */
	readonly maxMs: number;
}

/**
 * Scales a deadline with the size of the payload it covers, so a large but
 * healthy job is not abandoned at a limit written for a small one.
 *
 * Two boundaries need this and reached for it separately: an upload whose
 * transfer time tracks its byte count, and a worker conversion whose
 * demux/transcode loop does the same. The rate and the bounds differ between
 * them, so each names its own; the arithmetic is the same and lives here.
 * @param byteLength - Size of the payload in bytes
 * @param budget - Floor, assumed throughput, and cap
 * @returns Timeout in milliseconds
 */
export function scaledTimeoutMs(
	byteLength: number,
	budget: ScaledTimeoutBudget,
): number {
	const scaled = budget.floorMs + Math.ceil(byteLength / budget.bytesPerMs);
	return Math.min(scaled, budget.maxMs);
}

/**
 * Formats a duration in seconds as a human-readable timecode. The width is
 * chosen from `referenceSeconds` (defaults to the value itself), so a set of
 * timecodes sharing one reference all render at the same width and line up:
 * a reference of one hour or more forces `h:mm:ss` (e.g. `0:01:49`), below an
 * hour uses `m:ss` (e.g. `12:23`). Negative or non-finite inputs collapse to
 * the matching zero (`0:00` or `0:00:00`).
 * @param totalSeconds - Duration in seconds to format
 * @param referenceSeconds - Reference used to pick the format/width; defaults
 *   to totalSeconds. Pass the total recording length so every marker aligns.
 * @returns Timecode string (e.g. "12:23" or "0:01:49")
 */
export function formatTimecode(
	totalSeconds: number,
	referenceSeconds: number = totalSeconds,
): string {
	const reference = Number.isFinite(referenceSeconds)
		? referenceSeconds
		: totalSeconds;
	const showHours =
		Number.isFinite(reference) && reference >= SECONDS_PER_HOUR;
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
		return showHours ? '0:00:00' : '0:00';
	}
	const rounded = Math.floor(totalSeconds);
	const hours = Math.floor(rounded / SECONDS_PER_HOUR);
	const minutes = Math.floor(
		(rounded % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
	);
	const seconds = rounded % SECONDS_PER_MINUTE;
	const paddedSeconds = String(seconds).padStart(2, '0');
	if (hours > 0 || showHours) {
		const paddedMinutes = String(minutes).padStart(2, '0');
		return `${String(hours)}:${paddedMinutes}:${paddedSeconds}`;
	}
	return `${String(minutes)}:${paddedSeconds}`;
}

/**
 * Parses a timecode string into a number of seconds. Accepts a plain
 * seconds count ("90", "90.5"), `m:ss`, and `h:mm:ss`, each optionally
 * carrying a fractional seconds component. Whitespace is ignored.
 * Returns null when the input is empty or malformed so callers can tell
 * "no timecode" from "zero seconds".
 * @param value - Timecode string to parse
 * @returns Seconds as a number, or null when the input is not a valid
 * timecode
 */
export function parseTimecode(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === '') {
		return null;
	}
	const parts = trimmed.split(':');
	if (parts.length > 3) {
		return null;
	}
	let seconds = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part === undefined) {
			return null;
		}
		// Only the last segment may carry a fractional component; the
		// hour and minute segments are whole numbers
		const isLast = index === parts.length - 1;
		const pattern = isLast ? /^\d+(\.\d+)?$/ : /^\d+$/;
		if (!pattern.test(part)) {
			return null;
		}
		seconds = seconds * 60 + Number(part);
	}
	return seconds;
}
