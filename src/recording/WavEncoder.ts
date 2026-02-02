/**
 * WAV encoder utility for converting AudioBuffer to WAV format.
 * @module recording/WavEncoder
 */

/**
 * Converts an AudioBuffer to a WAV Blob.
 * @param audioBuffer - The audio buffer to convert
 * @param length - The length of samples to convert
 * @returns WAV format Blob
 */
export function bufferToWave(audioBuffer: AudioBuffer, length: number): Blob {
	const numOfChan = audioBuffer.numberOfChannels;
	const totalLength = length * numOfChan * 2 + 44;
	const buffer = new ArrayBuffer(totalLength);
	const view = new DataView(buffer);
	const channels: Float32Array[] = [];
	let offset = 0;

	// Write RIFF header
	writeString(view, offset, 'RIFF');
	offset += 4;
	view.setUint32(offset, totalLength - 8, true);
	offset += 4;
	writeString(view, offset, 'WAVE');
	offset += 4;

	// Write fmt subchunk
	writeString(view, offset, 'fmt ');
	offset += 4;
	view.setUint32(offset, 16, true); // Subchunk1Size
	offset += 4;
	view.setUint16(offset, 1, true); // AudioFormat (PCM)
	offset += 2;
	view.setUint16(offset, numOfChan, true); // NumChannels
	offset += 2;
	view.setUint32(offset, audioBuffer.sampleRate, true); // SampleRate
	offset += 4;
	view.setUint32(offset, audioBuffer.sampleRate * 2 * numOfChan, true); // ByteRate
	offset += 4;
	view.setUint16(offset, numOfChan * 2, true); // BlockAlign
	offset += 2;
	view.setUint16(offset, 16, true); // BitsPerSample
	offset += 2;

	// Write data subchunk
	writeString(view, offset, 'data');
	offset += 4;
	view.setUint32(offset, totalLength - 44, true); // Subchunk2Size
	offset += 4;

	// Get channel data
	for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
		channels.push(audioBuffer.getChannelData(i));
	}

	// Write interleaved audio data
	const sampleCount = Math.min(length, audioBuffer.length);
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
		for (let channelIndex = 0; channelIndex < numOfChan; channelIndex++) {
			const sample = Math.max(
				-1,
				Math.min(1, channels[channelIndex][sampleIndex]),
			);
			const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
			view.setInt16(
				44 + sampleIndex * numOfChan * 2 + channelIndex * 2,
				intSample,
				true,
			);
		}
	}

	return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Writes a string to a DataView at the specified offset.
 * @param view - The DataView to write to
 * @param offset - The byte offset
 * @param str - The string to write
 */
function writeString(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}

/**
 * Creates a WAV header info object for debugging.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param dataLength - Length of audio data in bytes
 * @returns Header information object
 */
export function getWavHeaderInfo(
	numChannels: number,
	sampleRate: number,
	dataLength: number,
): { headerSize: number; totalSize: number; byteRate: number } {
	return {
		headerSize: 44,
		totalSize: dataLength + 44,
		byteRate: sampleRate * 2 * numChannels,
	};
}
