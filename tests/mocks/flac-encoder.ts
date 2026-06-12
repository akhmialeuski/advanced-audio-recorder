/**
 * Mock for @mediabunny/flac-encoder.
 * The real module registers a custom FLAC encoder with mediabunny.
 * In tests, registration is a no-op.
 */
export const registerFlacEncoder = (): void => {
	// Mock implementation
};
