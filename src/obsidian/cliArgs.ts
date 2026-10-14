/**
 * Reading what was typed after a command on the Obsidian command line.
 *
 * Obsidian hands a handler its arguments as one flat record of strings
 * ({@link CliData}): a parameter typed `name=value` arrives as that value, and
 * a flag typed as a bare word arrives as the string `'true'`. The same is true
 * of a parameter typed without its value, which is why a value of `'true'`
 * reads here as "no value given" rather than as a value: no path, number or
 * label this plugin takes is spelled that way, and an answer saying the value
 * is missing is one the user can act on.
 *
 * Every reader answers with either the value or the sentence to answer the
 * command with, so a handler never throws over what the user typed.
 * @module obsidian/cliArgs
 */

import type { CliData, CliFlag } from 'obsidian';
import { parseTimecode } from '../utils/TimeUtils';

/** What a reader found: the value, or the reason to refuse the command. */
export type CliRead<T> = { readonly value: T } | { readonly refusal: string };

/** The string Obsidian passes for a bare flag or a parameter left empty. */
const BARE = 'true';

/** Values a switch accepts as off, matched without regard to case. */
const OFF_WORDS: ReadonlySet<string> = new Set(['off', 'false', 'no', '0']);

/** Values a switch accepts as on, matched without regard to case. */
const ON_WORDS: ReadonlySet<string> = new Set(['on', 'true', 'yes', '1']);

/**
 * Whether a reader refused rather than read.
 * @param read - What the reader answered
 */
export function isRefusal<T>(
	read: CliRead<T>,
): read is { readonly refusal: string } {
	return 'refusal' in read;
}

/**
 * The value of a `name=value` parameter, trimmed.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @returns The value, or null when it was not given or given empty
 */
export function cliText(args: CliData, name: string): string | null {
	const raw = args[name];
	if (raw === undefined || raw === BARE) {
		return null;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Whether a bare-word flag was typed. `name=off` (or `false`, `no`, `0`) reads
 * as not typed, so a script can pass the flag's state rather than branch on it.
 * @param args - The arguments as typed
 * @param name - Flag name
 */
export function cliFlag(args: CliData, name: string): boolean {
	const raw = args[name];
	return raw !== undefined && !OFF_WORDS.has(raw.trim().toLowerCase());
}

/**
 * A parameter restricted to a fixed set of values.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @param choices - The accepted values, in the order the refusal lists them
 * @returns The chosen value, null when not given, or the refusal naming
 *   what is accepted
 */
export function cliChoice<T extends string>(
	args: CliData,
	name: string,
	choices: readonly T[],
): CliRead<T | null> {
	const text = cliText(args, name);
	if (text === null) {
		return { value: null };
	}
	const chosen = choices.find(
		(choice) => choice.toLowerCase() === text.toLowerCase(),
	);
	return chosen === undefined
		? {
				refusal: `${name}=${text} is not one of: ${choices.join(', ')}.`,
			}
		: { value: chosen };
}

/**
 * A parameter that switches something on or off for one run.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @returns True or false, null when not given, or the refusal
 */
export function cliSwitch(
	args: CliData,
	name: string,
): CliRead<boolean | null> {
	const raw = args[name];
	if (raw === undefined) {
		return { value: null };
	}
	const word = raw.trim().toLowerCase();
	if (ON_WORDS.has(word)) {
		return { value: true };
	}
	if (OFF_WORDS.has(word)) {
		return { value: false };
	}
	return { refusal: `${name}=${raw} is not on or off.` };
}

/** Bounds a numeric parameter must lie within. */
export interface CliNumberRange {
	/** Smallest accepted value. */
	readonly min: number;
	/** Largest accepted value. */
	readonly max: number;
	/** Whether only whole numbers are accepted. */
	readonly integer?: boolean;
}

/**
 * A numeric parameter within a range.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @param range - The bounds the value must respect
 * @returns The number, null when not given, or the refusal naming the bounds
 */
export function cliNumber(
	args: CliData,
	name: string,
	range: CliNumberRange,
): CliRead<number | null> {
	const text = cliText(args, name);
	if (text === null) {
		return { value: null };
	}
	const value = Number(text);
	const kind = range.integer ? 'a whole number' : 'a number';
	if (
		!/^-?\d+(\.\d+)?$/.test(text) ||
		(range.integer && !Number.isInteger(value)) ||
		value < range.min ||
		value > range.max
	) {
		return {
			refusal: `${name}=${text} is not ${kind} from ${String(range.min)} to ${String(range.max)}.`,
		};
	}
	return { value };
}

/**
 * A position in a recording: plain seconds, `m:ss` or `h:mm:ss`, the same
 * forms the `#t=` links of a transcript carry.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @returns Seconds, null when not given, or the refusal
 */
export function cliTime(args: CliData, name: string): CliRead<number | null> {
	const text = cliText(args, name);
	if (text === null) {
		return { value: null };
	}
	const seconds = parseTimecode(text);
	return seconds === null
		? {
				refusal: `${name}=${text} is not a time: use seconds, m:ss or h:mm:ss.`,
			}
		: { value: seconds };
}

/**
 * Declares a `name=value` parameter for the CLI's help and completion.
 * @param placeholder - What the value is, e.g. `<vault path>`
 * @param description - One line for the help output
 */
export function valueParam(placeholder: string, description: string): CliFlag {
	return { value: placeholder, description };
}

/**
 * Declares a bare-word flag for the CLI's help and completion.
 * @param description - One line for the help output
 */
export function flagParam(description: string): CliFlag {
	return { description };
}

/**
 * Declares a parameter restricted to a fixed set of values.
 * @param choices - The accepted values
 * @param description - One line for the help output
 */
export function choiceParam(
	choices: readonly string[],
	description: string,
): CliFlag {
	return { value: choices.join('|'), description };
}
