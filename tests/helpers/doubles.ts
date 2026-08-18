/**
 * Naming the casts a test double needs, instead of spelling them out.
 *
 * A test that drives one path builds only the slice of a collaborator that
 * path touches, and the type system has no way to express "deliberately
 * partial". Written inline, `{...} as unknown as Vault` reads like a mistake
 * and hides real type drift among the intentional gaps. Written as
 * `partial<Vault>({...})` it says what it is, is greppable on its own, and
 * puts the reason in one place.
 *
 * These are the only sanctioned way to widen a type in a test. A bare
 * `as unknown as` in a test body is a smell: either the double is missing
 * something the code genuinely uses, or the type is wrong.
 * @module tests/helpers/doubles
 */

/**
 * A deliberately partial stand-in, typed as the thing it stands in for.
 *
 * Use it when the code under test reads a few members of a large interface -
 * a Vault it only reads one file from, a MediaStream it only passes through.
 * @param parts - The slice the code under test actually uses
 * @returns The same object, typed as T
 */
export function partial<T>(parts: object): T {
	return parts as T;
}

/**
 * The private members of an instance, for behaviour with no public entry.
 *
 * Some behaviour is only reachable through a closure a constructor handed to
 * a collaborator, or a handler only the DOM calls. Reaching it directly is
 * better than widening production code to be testable, but the reach should
 * be named, and typed by the test rather than left as `any`.
 * @param instance - The object whose internals the test drives
 * @returns The same object, typed as the test describes it
 */
export function internalsOf<T>(instance: object): T {
	return instance as T;
}

/**
 * The global object as a writable bag, for the browser APIs jsdom omits.
 *
 * Assigning to `globalThis.MediaRecorder` needs a cast whatever the test does;
 * this keeps it to one place and makes the assignments greppable.
 * @returns globalThis, indexable by name
 */
export function globals(): Record<string, unknown> {
	return globalThis;
}
