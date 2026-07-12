/**
 * Web Audio bridge that turns a capture MediaStream into a mono stream
 * before it reaches a MediaRecorder, so compressed recordings are
 * encoded as mono directly - no second lossy generation, and the
 * encoder spends its whole bitrate on one channel.
 *
 * Graph: MediaStreamAudioSourceNode -> ChannelSplitterNode -> (a 1/N
 * GainNode for the mix mode, or a direct route for the picked-channel
 * modes) -> MediaStreamAudioDestinationNode constrained to one channel.
 * The mix mode computes the plain average of every input channel -
 * identical to the PCM capture worklet and the downmix helpers - by
 * summing the split mono lanes and scaling by 1/N, instead of relying
 * on the destination's speaker-rules downmix (which weights 5.1
 * layouts and drops the LFE). The PCM/WAV path does not use this
 * bridge - its capture worklet downmixes itself (see PcmStreamRecorder).
 * @module recording/MonoCaptureBridge
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	isMonoChannelMode,
	monoPickIndex,
	type ChannelMode,
} from '../audio/downmix';

/**
 * Bridges one capture stream to a mono MediaStream for MediaRecorder.
 */
export class MonoCaptureBridge {
	private context: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private splitterNode: ChannelSplitterNode | null = null;
	private gainNode: GainNode | null = null;
	private destinationNode: MediaStreamAudioDestinationNode | null = null;

	/**
	 * Creates a new MonoCaptureBridge.
	 * @param stream - Source capture stream (stays owned by the caller;
	 * the bridge never stops its tracks)
	 * @param mode - Mono channel mode (mix or a picked channel)
	 * @param requestedSampleRate - Sample rate for the bridge context
	 * @throws Error for the source pass-through mode, where a bridge
	 * would silently downmix audio the user asked to keep
	 */
	constructor(
		private readonly stream: MediaStream,
		private readonly mode: ChannelMode,
		private readonly requestedSampleRate: number,
	) {
		if (!isMonoChannelMode(mode)) {
			throw new Error('MonoCaptureBridge requires a mono channel mode');
		}
	}

	/**
	 * Builds the audio graph and returns the mono stream to record.
	 * The context resume is awaited and verified: a context stuck in
	 * the suspended state would feed the recorder pure silence while
	 * the input-level meter (which taps the raw stream) still shows a
	 * live signal, so failing the recording start is the only outcome
	 * the user can notice in time. A failure releases everything
	 * acquired so far: the caller has no handle to clean a partially
	 * started bridge, and an unreleased AudioContext counts against a
	 * global limit.
	 * @returns Mono MediaStream for the MediaRecorder
	 * @throws Error when the audio context cannot reach the running
	 * state or the graph cannot be built
	 */
	async start(): Promise<MediaStream> {
		try {
			this.context = new AudioContext({
				sampleRate: this.requestedSampleRate,
			});
			// A context may start suspended until a user gesture
			if (this.context.state === 'suspended') {
				await this.context.resume();
			}
			if (this.context.state !== 'running') {
				throw new Error(
					'The mono recording bridge could not start its audio context; the recording would be silent.',
				);
			}
			this.sourceNode = this.context.createMediaStreamSource(this.stream);
			this.destinationNode = this.context.createMediaStreamDestination();
			this.destinationNode.channelCount = 1;
			this.destinationNode.channelCountMode = 'explicit';
			this.destinationNode.channelInterpretation = 'speakers';

			const sourceChannels = this.resolveSourceChannels();
			const pick = monoPickIndex(this.mode, sourceChannels);
			if (pick !== null) {
				// The splitter's channelInterpretation is 'discrete', so
				// its size must cover the real source channels: padded
				// outputs are silence, and monoPickIndex already clamps
				// the pick into the channels that actually exist
				this.splitterNode = this.context.createChannelSplitter(
					Math.max(2, sourceChannels),
				);
				this.sourceNode.connect(this.splitterNode);
				this.splitterNode.connect(this.destinationNode, pick, 0);
			} else if (sourceChannels <= 1) {
				// Already mono: nothing to mix
				this.sourceNode.connect(this.destinationNode);
			} else {
				// Mix: split into mono lanes, sum them at the gain input,
				// and scale by 1/N - the exact average of every channel,
				// matching the PCM capture worklet and downmixChannelData
				this.splitterNode =
					this.context.createChannelSplitter(sourceChannels);
				this.gainNode = this.context.createGain();
				this.gainNode.gain.value = 1 / sourceChannels;
				this.sourceNode.connect(this.splitterNode);
				for (let channel = 0; channel < sourceChannels; channel++) {
					this.splitterNode.connect(this.gainNode, channel, 0);
				}
				this.gainNode.connect(this.destinationNode);
			}
			return this.destinationNode.stream;
		} catch (error) {
			this.release();
			throw error;
		}
	}

	/**
	 * Number of channels the source stream delivers, preferring the
	 * track's own settings over the source node's channelCount (which
	 * some engines leave at its default of 2 for mono tracks).
	 */
	private resolveSourceChannels(): number {
		const track = this.stream.getAudioTracks()[0];
		const fromTrack = track?.getSettings().channelCount;
		if (typeof fromTrack === 'number' && fromTrack > 0) {
			return fromTrack;
		}
		return this.sourceNode?.channelCount ?? 2;
	}

	/**
	 * Disconnects the graph, stops the bridged output tracks, and closes
	 * the AudioContext. Never throws: it runs on the normal stop path
	 * and inside the start() failure path, where a secondary error must
	 * not mask the original one. The source stream's tracks are left
	 * running - the recording session owns and stops them.
	 */
	release(): void {
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.splitterNode) {
			this.splitterNode.disconnect();
			this.splitterNode = null;
		}
		if (this.gainNode) {
			this.gainNode.disconnect();
			this.gainNode = null;
		}
		if (this.destinationNode) {
			for (const track of this.destinationNode.stream.getTracks()) {
				track.stop();
			}
			this.destinationNode = null;
		}
		if (this.context) {
			this.context.close().catch((error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to close mono bridge AudioContext:`,
					error,
				);
			});
			this.context = null;
		}
	}
}
