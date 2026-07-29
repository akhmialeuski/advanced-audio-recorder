/**
 * Short microphone test capture used by the settings tab. Owns the
 * getUserMedia/MediaRecorder lifecycle (the settings tab previously
 * embedded this as a second mini recording implementation); rendering
 * of status and playback stays with the caller.
 * @module recording/TestRecorder
 */

import { MIME_TYPE_AUDIO_PREFIX } from '../constants';
import { resolveRecorderFormat } from '../audio/AudioFormatConverter';
import { isMonoChannelMode, normalizeChannelMode } from '../audio/downmix';
import { MonoCaptureBridge } from './MonoCaptureBridge';
import {
	getProcessingConstraints,
	resolveCaptureDeviceId,
} from './AudioStreamHandler';
import type { AudioRecorderSettings } from '../settings/settingsSchema';

/** Outcome of one test capture. */
export type TestRecordingResult =
	/** The recorder format is not supported by this browser. */
	| { kind: 'unsupported' }
	/** cancel() discarded the run before it finished. */
	| { kind: 'cancelled' }
	/** The recorder produced no data. */
	| { kind: 'empty' }
	/** The captured audio, ready for playback. */
	| { kind: 'recorded'; blob: Blob };

/**
 * Records a few seconds from the configured input device for the
 * settings "test recording" feature.
 */
export class TestRecorder {
	private recorder: MediaRecorder | null = null;

	/**
	 * Runs one capture. The microphone stream is released in a finally
	 * block, so a recorder-setup error or a cancel() during the wait
	 * can never leave the device captured.
	 * @param settings - Plugin settings (device, format, rates)
	 * @param durationMs - Capture length in milliseconds
	 * @param onStarted - Called once the recorder has been created,
	 *   before capture begins (the caller shows its progress UI here)
	 * @returns The capture outcome
	 */
	async record(
		settings: AudioRecorderSettings,
		durationMs: number,
		onStarted?: () => void,
	): Promise<TestRecordingResult> {
		let stream: MediaStream | null = null;
		let monoBridge: MonoCaptureBridge | null = null;
		try {
			this.cancel();

			// Resolve the capture container exactly like a real session
			// (native format, or the platform's intermediate), so the test
			// exercises the same recorder path recording would use.
			let recorderFormat: string;
			let mimeType: string;
			try {
				({ recorderFormat, mimeType } = resolveRecorderFormat(
					settings.recordingFormat,
				));
			} catch {
				return { kind: 'unsupported' };
			}

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

			// Capture through the same mono bridge real recordings use,
			// so the played-back test reflects the channel setting
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

			const chunks: Blob[] = [];
			// Local reference: cancel() may null this.recorder at any
			// await point below
			const recorder = new MediaRecorder(captureStream, {
				mimeType,
				audioBitsPerSecond: settings.bitrate,
			});
			this.recorder = recorder;

			recorder.ondataavailable = (event: BlobEvent): void => {
				if (event.data.size > 0) {
					chunks.push(event.data);
				}
			};

			onStarted?.();

			const recordingPromise = new Promise<void>((resolve) => {
				recorder.addEventListener('stop', () => resolve(), {
					once: true,
				});
			});

			recorder.start();

			await new Promise<void>((resolve) =>
				window.setTimeout(resolve, durationMs),
			);

			if (recorder.state !== 'inactive') {
				recorder.stop();
			}
			await recordingPromise;

			if (this.recorder !== recorder) {
				// cancel() ran during the wait: the result has nowhere
				// to go
				return { kind: 'cancelled' };
			}
			this.recorder = null;

			if (chunks.length === 0) {
				return { kind: 'empty' };
			}

			return {
				kind: 'recorded',
				blob: new Blob(chunks, {
					type: `${MIME_TYPE_AUDIO_PREFIX}${recorderFormat}`,
				}),
			};
		} finally {
			monoBridge?.release();
			if (stream) {
				for (const track of stream.getTracks()) {
					track.stop();
				}
			}
		}
	}

	/**
	 * Stops and discards a capture in progress. A pending record() call
	 * resolves as cancelled.
	 */
	cancel(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			this.recorder.stop();
		}
		this.recorder = null;
	}
}
