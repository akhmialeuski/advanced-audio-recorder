/**
 * A microphone capture held in memory rather than written to the vault.
 *
 * Two features need audio that is never saved: the settings tab's test
 * capture, which plays a few seconds back, and a quick note, whose audio only
 * lives until it has been transcribed. Both get the same getUserMedia and
 * MediaRecorder lifecycle from here, with the device, the channel mode and the
 * bitrate floor resolved exactly as a real recording session resolves them, so
 * neither carries a second mini recording implementation. What the caller does
 * with the clip stays with the caller.
 * @module recording/MemoryRecorder
 */

import { resolveRecorderFormat } from '../audio/AudioFormatConverter';
import { effectiveBitrate } from '../audio/AudioCapabilityDetector';
import { isMonoChannelMode, normalizeChannelMode } from '../audio/downmix';
import { MonoCaptureBridge } from './MonoCaptureBridge';
import {
	getProcessingConstraints,
	recordingEncodingFor,
	resolveCaptureDeviceId,
} from './AudioStreamHandler';
import type { AudioRecorderSettings } from '../settings/settingsSchema';

/** Outcome of one capture. */
export type MemoryRecordingResult =
	/** The recorder format is not supported by this browser. */
	| { kind: 'unsupported' }
	/** cancel() discarded the run before it finished. */
	| { kind: 'cancelled' }
	/** The recorder produced no data. */
	| { kind: 'empty' }
	/** The captured audio, in the container the platform recorded. */
	| { kind: 'recorded'; blob: Blob; recorderFormat: string };

/** How an attempt to start a capture ended. */
export const CaptureStart = {
	/** The microphone is open and the recorder is running. */
	Started: 'started',
	/** No recorder format this browser supports; the microphone was not opened. */
	Unsupported: 'unsupported',
	/** cancel() ran while the microphone was being opened. */
	Cancelled: 'cancelled',
} as const;

/** One start outcome (derived from {@link CaptureStart}). */
export type CaptureStart = (typeof CaptureStart)[keyof typeof CaptureStart];

/** Everything one running capture holds until it is stopped or cancelled. */
interface ActiveCapture {
	readonly recorder: MediaRecorder;
	readonly stream: MediaStream;
	readonly monoBridge: MonoCaptureBridge | null;
	readonly chunks: Blob[];
	readonly mimeType: string;
	readonly recorderFormat: string;
	/** Settles once the recorder has delivered its last chunk. */
	readonly stopped: Promise<void>;
}

/**
 * Records from the configured input device into memory, one capture at a
 * time.
 */
export class MemoryRecorder {
	private capture: ActiveCapture | null = null;
	/**
	 * Bumped by every start and every cancel, so a start still waiting on the
	 * microphone can tell that it was cancelled meanwhile and release the
	 * device instead of arming a capture nobody will stop.
	 */
	private generation = 0;

	/** Whether a capture is running. */
	isRecording(): boolean {
		return this.capture !== null;
	}

	/**
	 * Opens the microphone and starts recording. Anything already running is
	 * cancelled first. The stream is released before this returns on every
	 * path that does not leave a capture running, so a recorder-setup error
	 * can never leave the device captured.
	 * @param settings - Plugin settings (device, format, rates)
	 * @returns How the start ended
	 */
	async start(settings: AudioRecorderSettings): Promise<CaptureStart> {
		this.cancel();
		const generation = this.generation;

		// Resolve the capture container exactly like a real session (native
		// format, or the platform's intermediate), so the capture exercises
		// the same recorder path a recording would use.
		let recorderFormat: string;
		let mimeType: string;
		try {
			({ recorderFormat, mimeType } = resolveRecorderFormat(
				settings.recordingFormat,
			));
		} catch {
			return CaptureStart.Unsupported;
		}

		let stream: MediaStream | null = null;
		let monoBridge: MonoCaptureBridge | null = null;
		try {
			// The same device resolution real capture uses: stored ids are
			// ignored where device selection is unavailable (mobile).
			const deviceId = resolveCaptureDeviceId(settings);
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					...(deviceId ? { deviceId: { exact: deviceId } } : {}),
					sampleRate: settings.sampleRate,
					...getProcessingConstraints(settings),
				},
			});

			// Capture through the same mono bridge real recordings use, so
			// the clip reflects the channel setting.
			const channelMode = normalizeChannelMode(
				settings.recordingChannels,
			);
			let captureStream: MediaStream = stream;
			if (isMonoChannelMode(channelMode)) {
				monoBridge = new MonoCaptureBridge(
					stream,
					channelMode,
					settings.sampleRate,
				);
				captureStream = await monoBridge.start();
			}
			if (generation !== this.generation) {
				releaseDevices(stream, monoBridge);
				return CaptureStart.Cancelled;
			}

			const chunks: Blob[] = [];
			const recorder = new MediaRecorder(captureStream, {
				mimeType,
				// The floor a real session applies, taken from the chosen
				// output format at the rate the encoder writes at, so the
				// capture is encoded the way the recording it stands in for
				// would be.
				audioBitsPerSecond: effectiveBitrate(
					settings.recordingFormat,
					settings.bitrate,
					recordingEncodingFor(settings).sampleRate,
				),
			});
			recorder.ondataavailable = (event: BlobEvent): void => {
				if (event.data.size > 0) {
					chunks.push(event.data);
				}
			};
			const stopped = new Promise<void>((resolve) => {
				recorder.addEventListener('stop', () => resolve(), {
					once: true,
				});
			});
			recorder.start();
			this.capture = {
				recorder,
				stream,
				monoBridge,
				chunks,
				mimeType,
				recorderFormat,
				stopped,
			};
			return CaptureStart.Started;
		} catch (error) {
			releaseDevices(stream, monoBridge);
			throw error;
		}
	}

	/**
	 * Stops the running capture and hands over what it recorded. The
	 * microphone is released whatever the recorder delivered.
	 * @returns The clip, or why there is none
	 */
	async stop(): Promise<MemoryRecordingResult> {
		const capture = this.capture;
		if (!capture) {
			return { kind: 'cancelled' };
		}
		try {
			if (capture.recorder.state !== 'inactive') {
				capture.recorder.stop();
			}
			await capture.stopped;
		} finally {
			releaseDevices(capture.stream, capture.monoBridge);
			if (this.capture === capture) {
				this.capture = null;
			}
		}
		if (capture.chunks.length === 0) {
			return { kind: 'empty' };
		}
		return {
			kind: 'recorded',
			// The type the platform agreed to record, which is also the type
			// of the bytes it produced, rather than one rebuilt from the
			// container name: an M4A file is an MP4 container and the recorder
			// only accepts it as audio/mp4, so labelling the blob audio/m4a
			// handed the preview element a type it has no decoder for while
			// the recording itself was fine.
			blob: new Blob(capture.chunks, { type: capture.mimeType }),
			recorderFormat: capture.recorderFormat,
		};
	}

	/**
	 * Runs one capture of a fixed length, for the settings test recording.
	 * @param settings - Plugin settings (device, format, rates)
	 * @param durationMs - Capture length in milliseconds
	 * @param onStarted - Called once the recorder is running (the caller
	 *   shows its progress UI here)
	 * @returns The capture outcome
	 */
	async record(
		settings: AudioRecorderSettings,
		durationMs: number,
		onStarted?: () => void,
	): Promise<MemoryRecordingResult> {
		const started = await this.start(settings);
		if (started !== CaptureStart.Started) {
			return { kind: started };
		}
		onStarted?.();
		await new Promise<void>((resolve) =>
			window.setTimeout(resolve, durationMs),
		);
		// A cancel() during the wait already discarded the capture, and stop
		// then reports it as cancelled: the result has nowhere to go.
		return this.stop();
	}

	/**
	 * Stops and discards a capture in progress, releasing the microphone at
	 * once. A pending start() or record() resolves as cancelled.
	 */
	cancel(): void {
		this.generation++;
		const capture = this.capture;
		this.capture = null;
		if (!capture) {
			return;
		}
		if (capture.recorder.state !== 'inactive') {
			capture.recorder.stop();
		}
		releaseDevices(capture.stream, capture.monoBridge);
	}
}

/**
 * Releases the microphone and the mono bridge built over it.
 * @param stream - The raw microphone stream, when it was opened
 * @param monoBridge - The bridge, when the channel mode needed one
 */
function releaseDevices(
	stream: MediaStream | null,
	monoBridge: MonoCaptureBridge | null,
): void {
	monoBridge?.release();
	for (const track of stream?.getTracks() ?? []) {
		track.stop();
	}
}
