/**
 * Web Audio bridge that turns a capture MediaStream into a mono stream
 * before it reaches a MediaRecorder, so compressed recordings are
 * encoded as mono directly - no second lossy generation, and the
 * encoder spends its whole bitrate on one channel.
 *
 * Graph: MediaStreamAudioSourceNode -> (optional ChannelSplitterNode
 * for the picked-channel modes) -> MediaStreamAudioDestinationNode
 * constrained to one channel. The mix mode relies on the destination's
 * speaker-rules downmix (0.5*(L+R) for stereo); the left/right modes
 * route exactly one source channel. The PCM/WAV path does not use this
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
	 * A failure releases everything acquired so far: the caller has no
	 * handle to clean a partially started bridge, and an unreleased
	 * AudioContext counts against a global limit.
	 * @returns Mono MediaStream for the MediaRecorder
	 */
	start(): MediaStream {
		try {
			this.context = new AudioContext({
				sampleRate: this.requestedSampleRate,
			});
			// A context may start suspended until a user gesture; resume
			// so the destination receives audio instead of silence
			if (this.context.state === 'suspended') {
				void this.context.resume().catch(() => {
					// Non-fatal here; the recorder would capture silence,
					// which the user notices immediately
				});
			}
			this.sourceNode = this.context.createMediaStreamSource(this.stream);
			this.destinationNode = this.context.createMediaStreamDestination();
			this.destinationNode.channelCount = 1;
			this.destinationNode.channelCountMode = 'explicit';
			this.destinationNode.channelInterpretation = 'speakers';

			const sourceChannels = this.resolveSourceChannels();
			const pick = monoPickIndex(this.mode, sourceChannels);
			if (pick === null) {
				// Mix: the destination's one-channel constraint downmixes
				// by the Web Audio speaker rules
				this.sourceNode.connect(this.destinationNode);
			} else {
				// The splitter's channelInterpretation is 'discrete', so
				// its size must cover the real source channels: padded
				// outputs are silence, and monoPickIndex already clamps
				// the pick into the channels that actually exist
				this.splitterNode = this.context.createChannelSplitter(
					Math.max(2, sourceChannels),
				);
				this.sourceNode.connect(this.splitterNode);
				this.splitterNode.connect(this.destinationNode, pick, 0);
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
