/**
 * Adapters that give non-disposable platform resources a Symbol.dispose /
 * Symbol.asyncDispose, so call sites can bind them with `using` /
 * `await using` instead of hand-written try/finally blocks.
 * @module utils/disposables
 */

/**
 * Wraps a resource with a synchronous dispose() (e.g. a mediabunny Input)
 * so a `using` binding releases it when the block exits - on success and
 * on every throw path alike.
 * @param resource - The resource to manage
 * @returns The same resource, made Disposable
 */
export function disposableOf<T extends { dispose(): void }>(
	resource: T,
): T & Disposable {
	const managed = resource as T & Disposable;
	managed[Symbol.dispose] = () => {
		resource.dispose();
	};
	return managed;
}

/**
 * Wraps an AudioContext-like resource so an `await using` binding closes
 * it when the block exits (skipping a context that is already closed,
 * which would throw).
 * @param context - The context to manage
 * @returns The same context, made AsyncDisposable
 */
export function autoClosing<
	T extends { state: AudioContextState; close(): Promise<void> },
>(context: T): T & AsyncDisposable {
	const managed = context as T & AsyncDisposable;
	managed[Symbol.asyncDispose] = async () => {
		if (context.state !== 'closed') {
			await context.close();
		}
	};
	return managed;
}
