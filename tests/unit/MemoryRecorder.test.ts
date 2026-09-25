/**
 * Unit tests for the in-memory capture behind the settings test recording and
 * quick notes, focused on the mono capture bridge integration and the stream
 * lifecycle.
 * @module tests/unit/MemoryRecorder.test
 */

import { CaptureStart, MemoryRecorder } from 'src/recording/MemoryRecorder';
import { InputLevelMonitor } from 'src/recording/InputLevelMonitor';
import type { MockInputLevelMonitor } from '../mocks/modules/inputLevelMonitor';
import { at } from '../helpers/assertions';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { partial } from '../helpers/doubles';
import { installAudioContextRate } from '../helpers/mediaMocks';
import {
	ChunkingMediaRecorder,
	installMicrophone,
} from '../helpers/memoryCapture';

// jsdom has no AudioContext, so the meter is the shared double; the level
// maths is covered by the monitor's own suite.
jest.mock('src/recording/InputLevelMonitor', () =>
	require('../mocks/modules/inputLevelMonitor'),
);

/** Bridge doubles created by the recorder under test. */
interface BridgeDouble {
	stream: MediaStream;
	mode: string;
	sampleRate: number;
	monoStream: MediaStream;
	start: jest.Mock;
	release: jest.Mock;
}
const createdBridges: BridgeDouble[] = [];

jest.mock('src/recording/MonoCaptureBridge', () => ({
	MonoCaptureBridge: jest
		.fn()
		.mockImplementation(
			(stream: MediaStream, mode: string, sampleRate: number) => {
				const monoStream = partial<MediaStream>({
					getTracks: () => [{ stop: jest.fn() }],
				});
				const bridge: BridgeDouble = {
					stream,
					mode,
					sampleRate,
					monoStream,
					start: jest.fn(() => monoStream),
					release: jest.fn(),
				};
				createdBridges.push(bridge);
				return bridge;
			},
		),
}));

describe('MemoryRecorder', () => {
	let settings: AudioRecorderSettings;
	let rawTrackStop: jest.Mock;
	let getUserMedia: jest.Mock;

	beforeEach(() => {
		createdBridges.length = 0;
		({ trackStop: rawTrackStop, getUserMedia } = installMicrophone());
		settings = { ...DEFAULT_SETTINGS, recordingFormat: 'webm' };
	});

	it('cuts the bitrate at the rate the encoder writes at, as a real session does', async () => {
		// The test capture stands in for a recording, so it is encoded the
		// way one would be: 22.05 kHz in the settings is a 48 kHz file on this
		// device, where MP3 has no table under 32 kbps.
		const device = installAudioContextRate(48000);
		settings.recordingFormat = 'mp3';
		settings.sampleRate = 22050;
		settings.bitrate = 24000;
		try {
			await new MemoryRecorder().record(settings, 0);
		} finally {
			device.restore();
		}

		expect(at(ChunkingMediaRecorder.instances, 0).options).toEqual(
			expect.objectContaining({ audioBitsPerSecond: 32000 }),
		);
	});

	it('tags the clip with the type the platform agreed to record', async () => {
		// An M4A file is an MP4 container and the recorder only accepts it as
		// audio/mp4. Rebuilding the type from the container name handed the
		// preview element audio/m4a, which it has no decoder for, so the clip
		// would not play back while the recording itself was fine.
		ChunkingMediaRecorder.isTypeSupported.mockImplementation(
			(mime: string) => mime === 'audio/mp4',
		);
		settings.recordingFormat = 'm4a';

		const result = await new MemoryRecorder().record(settings, 0);

		expect(at(ChunkingMediaRecorder.instances, 0).options).toEqual(
			expect.objectContaining({ mimeType: 'audio/mp4' }),
		);
		expect(result.kind === 'recorded' && result.blob.type).toBe(
			'audio/mp4',
		);
	});

	it('records the raw stream in the source mode', async () => {
		const result = await new MemoryRecorder().record(settings, 0);

		expect(result.kind).toBe('recorded');
		expect(createdBridges).toHaveLength(0);
		expect(rawTrackStop).toHaveBeenCalledTimes(1);
	});

	it('records through the mono bridge in a mono mode and releases it', async () => {
		settings.recordingChannels = 'mono-right';
		settings.sampleRate = 48000;

		const result = await new MemoryRecorder().record(settings, 0);

		expect(result.kind).toBe('recorded');
		expect(createdBridges).toHaveLength(1);
		const bridge = at(createdBridges, 0);
		expect(bridge.mode).toBe('mono-right');
		expect(bridge.sampleRate).toBe(48000);
		expect(at(ChunkingMediaRecorder.instances, 0).stream).toBe(
			bridge.monoStream,
		);
		expect(bridge.release).toHaveBeenCalledTimes(1);
		// The microphone stream is still stopped by the recorder itself
		expect(rawTrackStop).toHaveBeenCalledTimes(1);
	});

	it('releases the bridge when the capture fails mid-run', async () => {
		settings.recordingChannels = 'mono-mix';
		// spyOn, not assignment: a plain assignment would leave the throwing
		// start on the prototype for every later test in any order but this one.
		jest.spyOn(ChunkingMediaRecorder.prototype, 'start').mockImplementation(
			() => {
				throw new Error('recorder failed');
			},
		);

		await expect(new MemoryRecorder().record(settings, 0)).rejects.toThrow(
			'recorder failed',
		);

		expect(at(createdBridges, 0).release).toHaveBeenCalledTimes(1);
		expect(rawTrackStop).toHaveBeenCalledTimes(1);
	});

	it('reports unsupported formats before touching the microphone', async () => {
		ChunkingMediaRecorder.isTypeSupported.mockReturnValue(false);

		const result = await new MemoryRecorder().record(settings, 0);

		expect(result.kind).toBe('unsupported');
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it('hands over what an open-ended capture recorded once it is stopped', async () => {
		// A quick note has no fixed length: the capture runs until the second
		// press, and the container it names is what the transcription is told.
		const recorder = new MemoryRecorder();

		expect(await recorder.start(settings)).toBe(CaptureStart.Started);
		expect(recorder.isRecording()).toBe(true);
		expect(rawTrackStop).not.toHaveBeenCalled();
		const result = await recorder.stop();

		expect(result).toEqual({
			kind: 'recorded',
			blob: expect.any(Blob) as Blob,
			recorderFormat: 'webm',
		});
		expect(recorder.isRecording()).toBe(false);
		expect(rawTrackStop).toHaveBeenCalledTimes(1);
	});

	it('releases the microphone at once when cancelled, and reports the stop as cancelled', async () => {
		const recorder = new MemoryRecorder();
		await recorder.start(settings);

		recorder.cancel();

		expect(rawTrackStop).toHaveBeenCalledTimes(1);
		expect(await recorder.stop()).toEqual({ kind: 'cancelled' });
	});

	it('closes a microphone that was still opening when the capture was cancelled', async () => {
		// The permission prompt can outlast the press that cancels it; the
		// stream arriving afterwards must not become a capture nobody stops.
		let grant: (stream: MediaStream) => void = () => undefined;
		const late = new Promise<MediaStream>((resolve) => {
			grant = resolve;
		});
		getUserMedia.mockReturnValueOnce(late);
		const recorder = new MemoryRecorder();

		const starting = recorder.start(settings);
		recorder.cancel();
		grant(
			partial<MediaStream>({ getTracks: () => [{ stop: rawTrackStop }] }),
		);

		expect(await starting).toBe(CaptureStart.Cancelled);
		expect(rawTrackStop).toHaveBeenCalledTimes(1);
		expect(ChunkingMediaRecorder.instances).toHaveLength(0);
		expect(recorder.isRecording()).toBe(false);
	});

	it('reports what it has recorded while it records, metered when asked', async () => {
		// The status bar shows a dictation's size and input level the way it
		// shows a recording's, so the capture reports both while it runs.
		const recorder = new MemoryRecorder();
		await recorder.start(settings, { meter: true });
		const meter = jest.mocked(InputLevelMonitor).mock
			.instances[0] as unknown as MockInputLevelMonitor;
		meter.getLevel.mockReturnValue(0.25);
		at(ChunkingMediaRecorder.instances, 0).ondataavailable?.({
			data: new Blob(['abc']),
		});

		expect(recorder.liveStats()).toEqual({
			elapsedMs: expect.any(Number) as number,
			bytes: 3,
			level: 0.25,
		});

		recorder.cancel();

		expect(recorder.liveStats()).toBeNull();
		expect(meter.stop).toHaveBeenCalledTimes(1);
	});

	it('meters nothing unless asked', async () => {
		const recorder = new MemoryRecorder();
		await recorder.start(settings);

		expect(recorder.liveStats()?.level).toBe(0);
		expect(InputLevelMonitor).not.toHaveBeenCalled();
	});
});
