/**
 * Real-time PCM audio capture using AudioWorkletNode.
 * Captures raw interleaved int16 PCM data from a MediaStream
 * for direct WAV encoding, avoiding memory-intensive post-hoc
 * decoding of compressed formats for long recordings.
 * @module recording/PcmStreamRecorder
 */

import {
	DEFAULT_SAMPLE_RATE,
	PCM_FLUSH_TIMEOUT_MS,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import {
	CHANNEL_MODE_SOURCE,
	CHANNEL_MODE_MONO_MIX,
	CHANNEL_MODE_MONO_RIGHT,
	isMonoChannelMode,
	type ChannelMode,
} from '../audio/downmix';

/**
 * Number of interleaved int16 samples to accumulate before posting.
 * 4096 at 44100 Hz ~ 93 ms (~11 posts/sec), matching the old
 * ScriptProcessorNode cadence and avoiding main-thread overload
 * from the 128-sample render quantum (~344 calls/sec).
 */
const WORKLET_BUFFER_SIZE = 4096;

/**
 * Inline AudioWorklet processor source code.
 * Runs on the audio rendering thread, converts float32 input
 * to interleaved int16 PCM, buffers it, and posts full chunks
 * back via MessagePort. Supports pause/resume/flush via port
 * messages. A mono channel mode (via processorOptions.channelMode)
 * downmixes during capture: averaging all input channels or keeping
 * one picked channel, so segments and the final WAV are mono at the
 * source. Exported for the worklet-logic unit tests, which evaluate
 * this source against a stub AudioWorkletProcessor.
 */
export const WORKLET_PROCESSOR_SOURCE = `
const BUFFER_SIZE = ${String(WORKLET_BUFFER_SIZE)};

class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this._paused = false;
		this._buffer = null;
		this._writeIndex = 0;
		this._channels = 0;
		const opts = (options && options.processorOptions) || {};
		this._mode = opts.channelMode || '${CHANNEL_MODE_SOURCE}';
		this.port.onmessage = (e) => {
			if (e.data.type === 'pause') this._paused = true;
			if (e.data.type === 'resume') this._paused = false;
			if (e.data.type === 'flush') this._flush();
		};
	}

	_flush() {
		if (this._buffer && this._writeIndex > 0) {
			const chunk = this._buffer.slice(0, this._writeIndex);
			this.port.postMessage(chunk.buffer, [chunk.buffer]);
			this._writeIndex = 0;
		}
		this.port.postMessage({ type: 'flushed' });
	}

	_toInt16(sample) {
		const clamped = Math.max(-1, Math.min(1, sample));
		return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
	}

	process(inputs) {
		if (this._paused) return true;
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const numChannels = input.length;
		const numSamples = input[0].length;
		const outChannels =
			this._mode === '${CHANNEL_MODE_SOURCE}' ? numChannels : 1;

		if (!this._buffer || this._channels !== outChannels) {
			this._channels = outChannels;
			this._buffer = new Int16Array(BUFFER_SIZE * outChannels);
			this._writeIndex = 0;
		}

		if (this._mode === '${CHANNEL_MODE_SOURCE}') {
			for (let i = 0; i < numSamples; i++) {
				for (let ch = 0; ch < numChannels; ch++) {
					this._buffer[this._writeIndex++] =
						this._toInt16(input[ch][i]);
				}
			}
		} else if (this._mode === '${CHANNEL_MODE_MONO_MIX}') {
			for (let i = 0; i < numSamples; i++) {
				let sum = 0;
				for (let ch = 0; ch < numChannels; ch++) {
					sum += input[ch][i];
				}
				this._buffer[this._writeIndex++] =
					this._toInt16(sum / numChannels);
			}
		} else {
			// Picked channel, clamped so a right pick on a mono
			// input records that input instead of silence
			const pick = Math.min(
				this._mode === '${CHANNEL_MODE_MONO_RIGHT}' ? 1 : 0,
				numChannels - 1,
			);
			const channel = input[pick];
			for (let i = 0; i < numSamples; i++) {
				this._buffer[this._writeIndex++] = this._toInt16(channel[i]);
			}
		}

		if (this._writeIndex >= this._buffer.length) {
			this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
			this._buffer = new Int16Array(BUFFER_SIZE * outChannels);
			this._writeIndex = 0;
		}

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
	private actualSampleRate: number = DEFAULT_SAMPLE_RATE;

	/**
	 * Creates a new PcmStreamRecorder.
	 * @param stream - MediaStream to capture audio from
	 * @param requestedSampleRate - Desired sample rate in Hz
	 * @param onChunk - Callback for receiving interleaved int16 PCM data
	 * @param channelMode - Channel layout: pass the source through or
	 * downmix to mono in the capture worklet
	 */
	constructor(
		private stream: MediaStream,
		private requestedSampleRate: number,
		private onChunk: PcmChunkCallback,
		private readonly channelMode: ChannelMode = CHANNEL_MODE_SOURCE,
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
	 * then connects source -> worklet -> gain(0) -> destination.
	 * A failure releases everything acquired up to that point: the
	 * caller has no handle to clean a partially started recorder, and
	 * an unreleased AudioContext counts against a global limit while
	 * the worklet blob URL would never be revoked.
	 */
	async start(): Promise<void> {
		try {
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
			// MediaStreamAudioSourceNode.channelCount is an input-mixing
			// attribute and stays at its default (commonly 2) even when
			// the source track is mono. Prefer the negotiated track
			// setting so the AudioWorklet width and WAV header describe
			// the samples the source actually delivers.
			const trackChannels =
				this.stream.getAudioTracks()[0]?.getSettings().channelCount;
			const sourceChannels =
				typeof trackChannels === 'number' && trackChannels > 0
					? trackChannels
					: this.sourceNode.channelCount;
			this.channelCount = isMonoChannelMode(this.channelMode)
				? 1
				: sourceChannels;

			this.workletNode = new AudioWorkletNode(
				this.audioContext,
				PROCESSOR_NAME,
				{
					numberOfInputs: 1,
					numberOfOutputs: 1,
					channelCount: sourceChannels,
					processorOptions: { channelMode: this.channelMode },
				},
			);

			// Receive PCM data from the worklet thread
			this.workletNode.port.onmessage = (event: MessageEvent): void => {
				if (event.data instanceof ArrayBuffer) {
					this.onChunk(event.data);
				}
			};

			// Mute output to prevent playback through speakers
			this.gainNode = this.audioContext.createGain();
			this.gainNode.gain.value = 0;

			// Connect: source -> worklet -> gain(0) -> destination
			this.sourceNode.connect(this.workletNode);
			this.workletNode.connect(this.gainNode);
			this.gainNode.connect(this.audioContext.destination);
		} catch (error) {
			await this.releaseResources();
			throw error;
		}
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
	 * Flushes any remaining buffered samples from the worklet. A
	 * watchdog resolves the wait if the `flushed` acknowledgement never
	 * arrives (dead audio subsystem), so stop() always reaches
	 * releaseResources() and the AudioContext and worklet blob URL are
	 * freed. The MediaRecorder path guards its stop event the same way.
	 */
	private async flushWorklet(): Promise<void> {
		const node = this.workletNode;
		if (!node) {
			return;
		}
		return new Promise<void>((resolve) => {
			const prev = node.port.onmessage;
			const finish = (): void => {
				window.clearTimeout(watchdog);
				node.port.onmessage = prev;
				resolve();
			};
			const watchdog = window.setTimeout(() => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} PCM flush acknowledgement timed out; releasing resources anyway`,
				);
				finish();
			}, PCM_FLUSH_TIMEOUT_MS);
			node.port.onmessage = (event: MessageEvent): void => {
				if (
					event.data &&
					typeof event.data === 'object' &&
					'type' in event.data &&
					(event.data as { type: string }).type === 'flushed'
				) {
					finish();
					return;
				}
				if (prev) {
					prev.call(node.port, event);
				}
			};
			node.port.postMessage({ type: 'flush' });
		});
	}

	/**
	 * Stops PCM capture and releases all audio resources.
	 */
	async stop(): Promise<void> {
		await this.flushWorklet();
		await this.releaseResources();
	}

	/**
	 * Disconnects the audio graph, closes the AudioContext, and revokes
	 * the worklet blob URL. Never throws: it runs both on the normal
	 * stop path and inside the start() failure path, where a secondary
	 * error must not mask the original one.
	 */
	private async releaseResources(): Promise<void> {
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
			try {
				await this.audioContext.close();
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to close AudioContext:`,
					error,
				);
			}
			this.audioContext = null;
		}
		if (this.workletBlobUrl) {
			URL.revokeObjectURL(this.workletBlobUrl);
			this.workletBlobUrl = null;
		}
	}
}
