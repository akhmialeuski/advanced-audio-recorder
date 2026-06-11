/**
 * Mock for @mediabunny/mp3-encoder.
 * The real module registers a custom MP3 encoder with mediabunny.
 * In tests, registration is a no-op.
 */
export const registerMp3Encoder = (): void => {
	// Mock implementation
};
