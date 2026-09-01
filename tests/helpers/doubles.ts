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

import type { ActionServices } from 'src/actions/PluginAction';

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

/**
 * Silences one console channel for a case that deliberately drives a failure
 * path, and restores it afterwards.
 *
 * Every such case wrote the same four lines: spy, empty implementation, a
 * comment saying the assertion is elsewhere, restore. Named once, a test says
 * only which channel it expects to be written to.
 * @param channel - The console method the case expects to be called
 * @returns The spy, so a case can assert on what was written
 */
export function silenceConsole(channel: 'warn' | 'error'): jest.SpyInstance {
	return jest.spyOn(console, channel).mockImplementation(() => {
		// The case asserts on the outcome, not on the console.
	});
}

/**
 * The transcription-queue half of an action-services double.
 *
 * Every harness that builds services needs it and none of them drives it, so
 * naming it once keeps three identical four-line blocks from being three
 * copies of the same thing.
 * @returns The queue port, with both calls recorded
 */
export function queueServicesDouble(): {
	queueFolder: jest.Mock;
	open: jest.Mock;
} {
	return {
		queueFolder: jest.fn().mockResolvedValue(undefined),
		open: jest.fn(),
	};
}

/**
 * The parts of an action-services double no harness varies: the settings
 * writer, the dialog options, the enhancement primer, the worker accessor,
 * and the chapter generator.
 *
 * Two harnesses spelled these out identically, which is ten lines of nothing
 * either of them is about. Named here, each says only what it varies: the
 * settings it runs under.
 * @returns The fixed half of an action-services double
 */
export function commonActionServices(): {
	saveSettings: () => Promise<void>;
	createTranscriptionModalOptions: () => Record<string, never>;
	primeForEnhancement: () => void;
	getWorkerClient: () => null;
	autoChapters: ActionServices['autoChapters'];
	transcriptionQueue: { queueFolder: jest.Mock; open: jest.Mock };
	recordingSidecar: ActionServices['recordingSidecar'];
} {
	return {
		saveSettings: () => Promise.resolve(),
		createTranscriptionModalOptions: () => ({}),
		primeForEnhancement: () => undefined,
		getWorkerClient: () => null,
		autoChapters: partial<ActionServices['autoChapters']>({
			generate: jest.fn(),
		}),
		transcriptionQueue: queueServicesDouble(),
		// A real double rather than an indexed partial, which yields
		// undefined: the split dialog is handed this to ask a recording for
		// its chapters.
		recordingSidecar: partial<ActionServices['recordingSidecar']>({
			getMarkers: jest.fn().mockResolvedValue([]),
			getTranscript: jest.fn().mockResolvedValue(null),
		}),
	};
}
