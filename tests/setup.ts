/**
 * Jest global setup: polyfill APIs missing from jsdom
 * that are required by bundled dependencies (e.g., mediabunny).
 */

import { TextDecoder, TextEncoder } from 'util';

if (typeof globalThis.TextDecoder === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).TextDecoder = TextDecoder;
}
if (typeof globalThis.TextEncoder === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).TextEncoder = TextEncoder;
}
