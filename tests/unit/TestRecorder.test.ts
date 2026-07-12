/**
 * Unit tests for the settings-tab test capture, focused on the mono
 * capture bridge integration and stream lifecycle.
 * @module tests/unit/TestRecorder.test
 */

import { TestRecorder } from 'src/recording/TestRecorder';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

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
				const monoStream = {
					getTracks: () => [{ stop: jest.fn() }],
				} as unknown as MediaStream;
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

/** MediaRecorder double that emits one chunk and stops synchronously. */
class MockMediaRecorder {
	static instances: MockMediaRecorder[] = [];
	static isTypeSupported = jest.fn().mockReturnValue(true);
	state = 'recording';
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	private stopHandler: (() => void) | null = null;

	constructor(
		public readonly stream: MediaStream,
		public readonly options: unknown,
	) {
		MockMediaRecorder.instances.push(this);
	}

	start(): void {
		this.state = 'recording';
	}

	stop(): void {
		this.state = 'inactive';
		this.ondataavailable?.({ data: new Blob(['chunk']) });
		this.stopHandler?.();
	}

	addEventListener(event: string, handler: () => void): void {
		if (event === 'stop') {
			this.stopHandler = handler;
		}
	}
}

function createRawStream(): { stream: MediaStream; trackStop: jest.Mock } {
	const trackStop = jest.fn();
	const stream = {
		getTracks: () => [{ stop: trackStop }],
	} as unknown as MediaStream;
	return { stream, trackStop };
}

describe('TestRecorder', () => {
	let settings: AudioRecorderSettings;
	let rawTrackStop: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		createdBridges.length = 0;
		MockMediaRecorder.instances = [];
		MockMediaRecorder.isTypeSupported.mockReturnValue(true);
		(global as Record<string, unknown>).MediaRecorder = MockMediaRecorder;
		const raw = createRawStream();
		rawTrackStop = raw.trackStop;
		(global.navigator as { mediaDevices?: unknown }).mediaDevices = {
			getUserMedia: jest.fn().mockResolvedValue(raw.stream),
		};
		settings = { ...DEFAULT_SETTINGS, recordingFormat: 'webm' };
	});

	it('records the raw stream in the source mode', async () => {
		const result = await new TestRecorder().record(settings, 0);

		expect(result.kind).toBe('recorded');
		expect(createdBridges).toHaveLength(0);
		expect(rawTrackStop).toHaveBeenCalled();
	});

	it('records through the mono bridge in a mono mode and releases it', async () => {
		settings.recordingChannels = 'mono-right';
		settings.sampleRate = 48000;

		const result = await new TestRecorder().record(settings, 0);

		expect(result.kind).toBe('recorded');
		expect(createdBridges).toHaveLength(1);
		const bridge = createdBridges[0];
		expect(bridge.mode).toBe('mono-right');
		expect(bridge.sampleRate).toBe(48000);
		expect(MockMediaRecorder.instances[0].stream).toBe(bridge.monoStream);
		expect(bridge.release).toHaveBeenCalled();
		// The microphone stream is still stopped by the recorder itself
		expect(rawTrackStop).toHaveBeenCalled();
	});

	it('releases the bridge when the capture fails mid-run', async () => {
		settings.recordingChannels = 'mono-mix';
		MockMediaRecorder.prototype.start = jest.fn(() => {
			throw new Error('recorder failed');
		});

		await expect(new TestRecorder().record(settings, 0)).rejects.toThrow(
			'recorder failed',
		);

		expect(createdBridges[0].release).toHaveBeenCalled();
		expect(rawTrackStop).toHaveBeenCalled();
	});

	it('reports unsupported formats before touching the microphone', async () => {
		MockMediaRecorder.isTypeSupported.mockReturnValue(false);

		const result = await new TestRecorder().record(settings, 0);

		expect(result.kind).toBe('unsupported');
		expect(
			(
				global.navigator.mediaDevices as unknown as {
					getUserMedia: jest.Mock;
				}
			).getUserMedia,
		).not.toHaveBeenCalled();
	});
});
