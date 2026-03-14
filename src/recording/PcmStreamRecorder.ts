/**
 * Real-time PCM audio capture using AudioWorkletNode.
 * Captures raw interleaved int16 PCM data from a MediaStream
 * for direct WAV encoding, avoiding memory-intensive post-hoc
 * decoding of compressed formats for long recordings.
 * @module recording/PcmStreamRecorder
 */

/**
 * Inline AudioWorklet processor source code.
 * Runs on the audio rendering thread, converts float32 input
 * to interleaved int16 PCM and posts it back via MessagePort.
 * Supports pause/resume via port messages.
 */
const WORKLET_PROCESSOR_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this._paused = false;
		this.port.onmessage = (e) => {
			if (e.data.type === 'pause') this._paused = true;
			if (e.data.type === 'resume') this._paused = false;
		};
	}

	process(inputs) {
		if (this._paused) return true;
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const numChannels = input.length;
		const numSamples = input[0].length;
		const int16Data = new Int16Array(numSamples * numChannels);

		for (let i = 0; i < numSamples; i++) {
			for (let ch = 0; ch < numChannels; ch++) {
				const sample = Math.max(-1, Math.min(1, input[ch][i]));
				int16Data[i * numChannels + ch] =
					sample < 0 ? sample * 0x8000 : sample * 0x7fff;
			}
		}

		this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
		return true;
	}
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

/** Registered processor name matching the worklet source. */
const PROCESSOR_NAME = 'pcm-capture-processor';

/**
 * Callback type for receiving interleaved int16 PCM data chunks.
 */
export type PcmChunkCallback = (data: ArrayBuffer) => void;

/**
 * Captures raw PCM audio from a MediaStream in real-time.
 *
 * Uses AudioWorkletNode to intercept audio samples on the audio
 * rendering thread, converts float32 to interleaved int16, and
 * delivers chunks to the main thread via MessagePort. Output is
 * muted through a zero-gain node to prevent speaker playback.
 */
export class PcmStreamRecorder {
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private gainNode: GainNode | null = null;
	private workletBlobUrl: string | null = null;
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
	 * Registers the AudioWorklet processor via inline Blob URL,
	 * then connects source → worklet → gain(0) → destination.
	 */
	async start(): Promise<void> {
		this.audioContext = new AudioContext({
			sampleRate: this.requestedSampleRate,
		});
		this.actualSampleRate = this.audioContext.sampleRate;

		// Register the inline worklet processor
		const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
			type: 'application/javascript',
		});
		this.workletBlobUrl = URL.createObjectURL(blob);
		await this.audioContext.audioWorklet.addModule(this.workletBlobUrl);

		this.sourceNode = this.audioContext.createMediaStreamSource(
			this.stream,
		);
		this.channelCount = this.sourceNode.channelCount;

		this.workletNode = new AudioWorkletNode(
			this.audioContext,
			PROCESSOR_NAME,
			{
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: this.channelCount,
			},
		);

		// Receive PCM data from the worklet thread
		this.workletNode.port.onmessage = (event: MessageEvent): void => {
			this.onChunk(event.data as ArrayBuffer);
		};

		// Mute output to prevent playback through speakers
		this.gainNode = this.audioContext.createGain();
		this.gainNode.gain.value = 0;

		// Connect: source → worklet → gain(0) → destination
		this.sourceNode.connect(this.workletNode);
		this.workletNode.connect(this.gainNode);
		this.gainNode.connect(this.audioContext.destination);
	}

	/**
	 * Pauses PCM capture. Audio frames are silently discarded in the worklet.
	 */
	pause(): void {
		this.workletNode?.port.postMessage({ type: 'pause' });
	}

	/**
	 * Resumes PCM capture after a pause.
	 */
	resume(): void {
		this.workletNode?.port.postMessage({ type: 'resume' });
	}

	/**
	 * Stops PCM capture and releases all audio resources.
	 */
	async stop(): Promise<void> {
		if (this.workletNode) {
			this.workletNode.port.onmessage = null;
			this.workletNode.disconnect();
			this.workletNode = null;
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
		if (this.workletBlobUrl) {
			URL.revokeObjectURL(this.workletBlobUrl);
			this.workletBlobUrl = null;
		}
	}
}
