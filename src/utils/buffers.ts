/**
 * Small binary-buffer helpers shared across recording and recovery.
 * @module utils/buffers
 */

/**
 * Concatenates a list of ArrayBuffers into one contiguous Uint8Array.
 * @param buffers - Buffers in output order
 * @returns A new Uint8Array holding every buffer back to back
 */
export function concatArrayBuffers(
	buffers: ArrayBuffer[],
): Uint8Array<ArrayBuffer> {
	const totalBytes = buffers.reduce(
		(sum, buffer) => sum + buffer.byteLength,
		0,
	);
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const buffer of buffers) {
		combined.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}
	return combined;
}
