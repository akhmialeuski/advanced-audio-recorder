/**
 * One track's capture, behind an interface that hides which primitive does it.
 *
 * A session records either through the browser's MediaRecorder or, for desktop
 * WAV, through a PCM worklet, and the two have nothing in common but their
 * lifecycle. That lifecycle used to be written twice: two parallel arrays,
 * filled exclusively, and a branch on the PCM flag repeated at initialization,
 * at pause, at stop and at teardown. Each of those four branches had to be
 * remembered and kept in step, and a missed one is how a failed start came to
 * leave an AudioContext open.
 *
 * Here the choice is made once, when the tracks are built, and every later step
 * is the same loop over the same list.
 * @module recording/CaptureTrack
 */

import { PLUGIN_LOG_PREFIX, RECORDER_STOP_TIMEOUT_MS } from '../constants';
import { isMonoChannelMode, type ChannelMode } from '../audio/downmix';
import { MonoCaptureBridge } from './MonoCaptureBridge';
import type { PcmStreamRecorder } from './PcmStreamRecorder';
import {
	createAndStartMediaRecorders,
	detachRecorderHandlers,
	type MediaRecorderConfig,
} from './RecorderFactory';

/** How one track is captured, for as long as its session runs. */
export interface CaptureTrack {
	/**
	 * Channels the primitive settled on, or null where it does not negotiate.
	 * The PCM worklet answers with what the device gave it; a MediaRecorder
	 * encodes whatever the stream carries and reports nothing.
	 */
	readonly negotiatedChannels: number | null;
	/** Sample rate the primitive settled on, or null where it does not negotiate. */
	readonly negotiatedSampleRate: number | null;
	/**
	 * Acquires everything capture needs, without capturing yet: a mono
	 * bridge's audio context, a worklet's module. This is the slow, variable
	 * half of starting, and separating it is what lets a session hold every
	 * track at the line.
	 */
	prepare(): Promise<void>;
	/**
	 * Begins capturing on what {@link CaptureTrack.prepare} acquired, without
	 * awaiting anything.
	 *
	 * Kept apart from the acquisition because the tracks of one session have
	 * to start together. A mono bridge reaches its running audio context after
	 * a delay that differs per track and per device, so a track that armed
	 * itself the moment its own bridge answered began recording tens of
	 * milliseconds before or after its siblings, and a merged multi-track file
	 * carried that difference as a fixed offset between two microphones for
	 * its whole length.
	 */
	begin(): void;
	/** Suspends capture, keeping everything acquired. */
	pause(): void;
	/** Resumes capture after {@link CaptureTrack.pause}. */
	resume(): void;
	/** Ends capture and waits for the last data to arrive. */
	stop(): Promise<void>;
	/**
	 * Starts a fresh recorder over the same capture, for the part rotation
	 * that has to leave each part a file that plays on its own. A capture
	 * that rotates by counting bytes instead has nothing to do here.
	 *
	 * The session's own paused state is re-applied here rather than by a
	 * separate call: between the old recorder stopping and the new one
	 * starting there is nothing to pause, so a pause the user asked for
	 * inside that window would otherwise be lost and the rebuilt part would
	 * come back running.
	 * @param paused - Whether the session is paused and the new recorder
	 * must come back paused with it
	 */
	restart(paused: boolean): void;
	/**
	 * Gives back everything the track acquired, on every path that ends a
	 * session including the rollback of a failed start. Never throws, and is
	 * safe to call after {@link CaptureTrack.stop} or twice.
	 * @param when - Names the path, for the log when something refuses to go
	 */
	release(when: string): void;
	/**
	 * Ends this track's output because its capture device has gone.
	 *
	 * A track recorded straight off its capture stream needs nothing: the
	 * browser ends a recorder whose stream went inactive. A bridged one
	 * records the bridge's own destination track, which stays live and would
	 * feed silence for the rest of the session, so the bridge has to be let
	 * go for the two paths to behave alike.
	 */
	detachFromDevice(): void;
}

/** Callbacks a MediaRecorder track reports through. */
export interface MediaCaptureCallbacks {
	/** Called with each non-empty data chunk. */
	onChunk: (data: Blob) => void;
	/** Called when the recorder reports an error event. */
	onError: (event: Event) => void;
}

/**
 * A track captured through the browser's MediaRecorder.
 *
 * A mono channel mode is applied at capture time by a bridge rather than at
 * finalization, so the recording never pays for a second lossy generation. The
 * bridge is built in the constructor and started separately, which is what lets
 * a session construct every track before starting any: a start that fails then
 * still has every acquired context to give back.
 */
export class MediaRecorderCaptureTrack implements CaptureTrack {
	readonly negotiatedChannels = null;
	readonly negotiatedSampleRate = null;
	private readonly bridge: MonoCaptureBridge | null;
	private captureStream: MediaStream;
	private recorder: MediaRecorder | null = null;

	constructor(
		private readonly stream: MediaStream,
		channelMode: ChannelMode,
		sampleRate: number,
		private readonly config: MediaRecorderConfig,
		private readonly callbacks: MediaCaptureCallbacks,
	) {
		this.bridge = isMonoChannelMode(channelMode)
			? new MonoCaptureBridge(stream, channelMode, sampleRate)
			: null;
		this.captureStream = stream;
	}

	async prepare(): Promise<void> {
		this.captureStream = (await this.bridge?.start()) ?? this.stream;
	}

	begin(): void {
		this.startRecorder();
	}

	pause(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			this.recorder.pause();
		}
	}

	resume(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			this.recorder.resume();
		}
	}

	stop(): Promise<void> {
		const recorder = this.recorder;
		if (!recorder) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			if (recorder.state === 'inactive') {
				resolve();
				return;
			}
			const watchdog = window.setTimeout(() => {
				console.error(
					`${PLUGIN_LOG_PREFIX} MediaRecorder stop event did not arrive within ${String(
						RECORDER_STOP_TIMEOUT_MS,
					)} ms; continuing with the data received so far`,
				);
				resolve();
			}, RECORDER_STOP_TIMEOUT_MS);
			recorder.addEventListener(
				'stop',
				() => {
					window.clearTimeout(watchdog);
					resolve();
				},
				{ once: true },
			);
			try {
				recorder.stop();
			} catch (error) {
				// The recorder went inactive between the state check and
				// stop(): its data is already delivered, nothing to wait for
				window.clearTimeout(watchdog);
				console.error(
					`${PLUGIN_LOG_PREFIX} MediaRecorder stop() failed:`,
					error,
				);
				resolve();
			}
		});
	}

	restart(paused: boolean): void {
		this.detach();
		this.startRecorder();
		if (paused) {
			this.recorder?.pause();
		}
	}

	detachFromDevice(): void {
		this.bridge?.release();
	}

	release(when: string): void {
		this.detach();
		const recorder = this.recorder;
		this.recorder = null;
		if (recorder) {
			try {
				if (recorder.state !== 'inactive') {
					recorder.stop();
				}
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to stop recorder ${when}:`,
					error,
				);
			}
		}
		this.bridge?.release();
	}

	/** Builds and starts a recorder over the capture stream. */
	private startRecorder(): void {
		const [recorder] = createAndStartMediaRecorders(
			[this.captureStream],
			this.config,
			{
				onChunk: (_index, data) => {
					this.callbacks.onChunk(data);
				},
				onError: (_index, event) => {
					this.callbacks.onError(event);
				},
			},
		);
		this.recorder = recorder ?? null;
	}

	/**
	 * Detaches the handlers of a recorder being discarded, so a chunk the
	 * browser already queued cannot fire into a part it does not belong to.
	 */
	private detach(): void {
		if (this.recorder) {
			detachRecorderHandlers([this.recorder]);
		}
	}
}

/**
 * A track captured as raw PCM through an audio worklet, for desktop WAV.
 *
 * The worklet reports the channel count and sample rate it settled on, which
 * the session records against the track so the WAV header written at the end
 * describes what was actually captured.
 */
export class PcmCaptureTrack implements CaptureTrack {
	constructor(private readonly recorder: PcmStreamRecorder) {}

	get negotiatedChannels(): number {
		return this.recorder.channels;
	}

	get negotiatedSampleRate(): number {
		return this.recorder.sampleRate;
	}

	prepare(): Promise<void> {
		// The worklet captures from the moment it is connected to the source,
		// and connecting it is the last thing its start does, so a PCM track's
		// whole start is its acquisition and there is nothing left to arm.
		return this.recorder.start();
	}

	begin(): void {
		// Already capturing; see prepare().
	}

	pause(): void {
		this.recorder.pause();
	}

	resume(): void {
		this.recorder.resume();
	}

	stop(): Promise<void> {
		return this.recorder.stop();
	}

	restart(): void {
		// A PCM session rotates by counting the bytes it has written, so the
		// worklet keeps running across a part boundary and keeps whatever
		// paused state it already had.
	}

	detachFromDevice(): void {
		// The worklet reads the stream itself, so a stream that went inactive
		// stops feeding it without anything here.
	}

	release(when: string): void {
		this.recorder.stop().catch((error: unknown) => {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to release PCM recorder ${when}:`,
				error,
			);
		});
	}
}
