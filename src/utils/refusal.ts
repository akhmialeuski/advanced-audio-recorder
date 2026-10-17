/**
 * The one shape every step that can refuse answers with: the value it was
 * asked for, or the sentence saying why it cannot be had.
 *
 * A refusal travels as its own field rather than as a bare string in a union
 * with the result, so a value that is itself a string can never be mistaken
 * for one. A refusal of one step narrows to a shape every other read accepts,
 * so a caller hands it on unchanged.
 * @module utils/refusal
 */

/** What a step produced: the value, or the reason it refused. */
export type Refusable<T> = { readonly value: T } | { readonly refusal: string };

/**
 * Whether a step refused rather than produced its value.
 * @param read - What the step answered
 */
export function isRefusal<T>(
	read: Refusable<T>,
): read is { readonly refusal: string } {
	return 'refusal' in read;
}

/**
 * The value of a step whose refusal ends the caller's work, as a confirmed
 * edit or a capture that cannot go on does.
 * @param read - What the step answered
 * @returns The value
 * @throws Error whose message is the refusal, as the user reads it
 */
export function valueOrThrow<T>(read: Refusable<T>): T {
	if (isRefusal(read)) {
		throw new Error(read.refusal);
	}
	return read.value;
}
