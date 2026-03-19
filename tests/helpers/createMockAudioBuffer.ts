/**
 * Shared test helper: creates a mock AudioBuffer for testing.
 * @param numberOfChannels - Number of audio channels
 * @param length - Number of samples
 * @param sampleRate - Sample rate in Hz
 * @returns Mock AudioBuffer object
 */
export function createMockAudioBuffer(
	numberOfChannels: number,
	length: number,
	sampleRate: number,
): AudioBuffer {
	const channels: Float32Array[] = [];
	for (let i = 0; i < numberOfChannels; i++) {
		channels.push(new Float32Array(length));
	}

	return {
		numberOfChannels,
		length,
		sampleRate,
		duration: length / sampleRate,
		getChannelData: (channel: number) => channels[channel],
		copyFromChannel: jest.fn(),
		copyToChannel: jest.fn(),
	} as unknown as AudioBuffer;
}
