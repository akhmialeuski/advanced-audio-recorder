/**
 * Real-time PCM audio capture using ScriptProcessorNode.
 * Captures raw interleaved int16 PCM data from a MediaStream
 * for direct WAV encoding, avoiding memory-intensive post-hoc
 * decoding of compressed formats for long recordings.
 * @module recording/PcmStreamRecorder
 */

/**
 * Buffer size for ScriptProcessorNode (samples per channel per callback).
 * 4096 at 44100 Hz gives ~93ms intervals (~11 callbacks/sec).
 */
const PROCESSOR_BUFFER_SIZE = 4096;

/**
 * Callback type for receiving interleaved int16 PCM data chunks.
 */
export type PcmChunkCallback = (data: ArrayBuffer) => void;

/**
 * Captures raw PCM audio from a MediaStream in real-time.
 *
 * Uses ScriptProcessorNode to intercept audio samples from an
 * AudioContext, converts float32 to interleaved int16, and
 * delivers chunks via callback. Output is muted through a
 * zero-gain node to prevent speaker playback.
 *
 * ScriptProcessorNode is used over AudioWorkletNode for broader
 * compatibility across Obsidian environments (desktop Electron
 * and mobile WebView) and simpler setup (no module loading).
 */
export class PcmStreamRecorder {
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private processorNode: ScriptProcessorNode | null = null;
	private gainNode: GainNode | null = null;
	private paused: boolean = false;
	private channelCount: number = 1;
	private actualSampleRate: number = 44100;

	/**
	 * Creates a new PcmStreamRecorder.
	 * @param stream - MediaStream to capture audio from
	 * @param requestedSampleRate - Desired sample rate in Hz
	 * @param onChunk - Callback for receiving interleaved int16 PCM data
	 */
	constructor(
		private stream: MediaStream,
		private requestedSampleRate: number,
		private onChunk: PcmChunkCallback,
	) {}

	/**
	 * Number of audio channels being captured.
	 */
	get channels(): number {
		return this.channelCount;
	}

	/**
	 * Actual sample rate of the AudioContext (may differ from requested).
	 */
	get sampleRate(): number {
		return this.actualSampleRate;
	}

	/**
	 * Starts capturing PCM audio data.
	 * Creates AudioContext, connects source → processor → gain(0) → destination.
	 */
	async start(): Promise<void> {
		this.audioContext = new AudioContext({
			sampleRate: this.requestedSampleRate,
		});
		this.actualSampleRate = this.audioContext.sampleRate;

		this.sourceNode = this.audioContext.createMediaStreamSource(
			this.stream,
		);
		this.channelCount = this.sourceNode.channelCount;

		// ScriptProcessorNode captures audio frames on the main thread
		this.processorNode = this.audioContext.createScriptProcessor(
			PROCESSOR_BUFFER_SIZE,
			this.channelCount,
			this.channelCount,
		);

		// Mute output to prevent playback through speakers
		this.gainNode = this.audioContext.createGain();
		this.gainNode.gain.value = 0;

		this.processorNode.onaudioprocess = (
			event: AudioProcessingEvent,
		): void => {
			if (this.paused) {
				return;
			}

			const inputBuffer = event.inputBuffer;
			const numSamples = inputBuffer.length;
			const numChannels = inputBuffer.numberOfChannels;

			// Convert float32 to interleaved int16 PCM
			const int16Data = new Int16Array(numSamples * numChannels);
			for (let sampleIndex = 0; sampleIndex < numSamples; sampleIndex++) {
				for (
					let channelIndex = 0;
					channelIndex < numChannels;
					channelIndex++
				) {
					const sample = Math.max(
						-1,
						Math.min(
							1,
							inputBuffer.getChannelData(channelIndex)[
								sampleIndex
							],
						),
					);
					int16Data[sampleIndex * numChannels + channelIndex] =
						sample < 0 ? sample * 0x8000 : sample * 0x7fff;
				}
			}

			this.onChunk(int16Data.buffer);
		};

		// Connect: source → processor → gain(0) → destination
		this.sourceNode.connect(this.processorNode);
		this.processorNode.connect(this.gainNode);
		this.gainNode.connect(this.audioContext.destination);
	}

	/**
	 * Pauses PCM capture. Audio data is silently discarded while paused.
	 */
	pause(): void {
		this.paused = true;
	}

	/**
	 * Resumes PCM capture after a pause.
	 */
	resume(): void {
		this.paused = false;
	}

	/**
	 * Stops PCM capture and releases all audio resources.
	 */
	async stop(): Promise<void> {
		if (this.processorNode) {
			this.processorNode.onaudioprocess = null;
			this.processorNode.disconnect();
			this.processorNode = null;
		}
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.gainNode) {
			this.gainNode.disconnect();
			this.gainNode = null;
		}
		if (this.audioContext) {
			await this.audioContext.close();
			this.audioContext = null;
		}
	}
}
