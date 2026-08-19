/**
 * Unit tests for MonoCaptureBridge: the Web Audio graph that feeds
 * MediaRecorder-based recordings a mono stream.
 * @module tests/unit/MonoCaptureBridge.test
 */

import { MonoCaptureBridge } from 'src/recording/MonoCaptureBridge';
import { partial } from '../helpers/doubles';

interface NodeDouble {
	connect: jest.Mock;
	disconnect: jest.Mock;
	channelCount?: number;
}

let mockSourceNode: NodeDouble & { channelCount: number };
let mockSplitterNode: NodeDouble;
let mockGainNode: NodeDouble & { gain: { value: number } };
let mockDestinationNode: {
	channelCount: number;
	channelCountMode: string;
	channelInterpretation: string;
	stream: MediaStream;
	disconnect: jest.Mock;
};
let destinationTrackStop: jest.Mock;
let mockAudioContext: {
	state: string;
	resume: jest.Mock;
	close: jest.Mock;
	createMediaStreamSource: jest.Mock;
	createMediaStreamDestination: jest.Mock;
	createChannelSplitter: jest.Mock;
	createGain: jest.Mock;
};

function createMockStream(channelCount?: number): MediaStream {
	return partial<MediaStream>({
		getAudioTracks: () => [
			{
				stop: jest.fn(),
				getSettings: () => ({ channelCount }),
			},
		],
		getTracks: () => [{ stop: jest.fn() }],
	});
}

beforeEach(() => {
	mockSourceNode = {
		connect: jest.fn(),
		disconnect: jest.fn(),
		channelCount: 2,
	};
	mockSplitterNode = { connect: jest.fn(), disconnect: jest.fn() };
	mockGainNode = {
		connect: jest.fn(),
		disconnect: jest.fn(),
		gain: { value: 1 },
	};
	destinationTrackStop = jest.fn();
	mockDestinationNode = {
		channelCount: 2,
		channelCountMode: 'explicit',
		channelInterpretation: 'speakers',
		stream: partial<MediaStream>({
			getTracks: () => [{ stop: destinationTrackStop }],
		}),
		disconnect: jest.fn(),
	};
	mockAudioContext = {
		state: 'running',
		resume: jest.fn().mockImplementation(() => {
			mockAudioContext.state = 'running';
			return Promise.resolve();
		}),
		close: jest.fn().mockResolvedValue(undefined),
		createMediaStreamSource: jest.fn().mockReturnValue(mockSourceNode),
		createMediaStreamDestination: jest
			.fn()
			.mockReturnValue(mockDestinationNode),
		createChannelSplitter: jest.fn().mockReturnValue(mockSplitterNode),
		createGain: jest.fn().mockReturnValue(mockGainNode),
	};
	(global as Record<string, unknown>).AudioContext = jest
		.fn()
		.mockImplementation(() => mockAudioContext);
});

describe('MonoCaptureBridge', () => {
	it('rejects the source pass-through mode', () => {
		expect(
			() => new MonoCaptureBridge(createMockStream(2), 'source', 44100),
		).toThrow('mono channel mode');
	});

	it('averages a stereo source through a splitter and a 1/2 gain', async () => {
		const stream = createMockStream(2);
		const bridge = new MonoCaptureBridge(stream, 'mono-mix', 48000);

		const monoStream = await bridge.start();

		expect(global.AudioContext).toHaveBeenCalledWith({
			sampleRate: 48000,
		});
		expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalledWith(
			stream,
		);
		expect(mockDestinationNode.channelCount).toBe(1);
		expect(mockDestinationNode.channelCountMode).toBe('explicit');
		expect(mockDestinationNode.channelInterpretation).toBe('speakers');
		// Exact average: mono lanes summed at the gain, scaled by 1/N
		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(2);
		expect(mockSourceNode.connect).toHaveBeenCalledWith(mockSplitterNode);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockGainNode,
			0,
			0,
		);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockGainNode,
			1,
			0,
		);
		expect(mockGainNode.gain.value).toBe(0.5);
		expect(mockGainNode.connect).toHaveBeenCalledWith(mockDestinationNode);
		expect(monoStream).toBe(mockDestinationNode.stream);
	});

	it('averages every lane of a 5.1 source with a 1/6 gain', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(6),
			'mono-mix',
			44100,
		);

		await bridge.start();

		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(6);
		for (let channel = 0; channel < 6; channel++) {
			expect(mockSplitterNode.connect).toHaveBeenCalledWith(
				mockGainNode,
				channel,
				0,
			);
		}
		expect(mockGainNode.gain.value).toBeCloseTo(1 / 6);
	});

	it('connects a mono source directly for the mix mode', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(1),
			'mono-mix',
			44100,
		);

		await bridge.start();

		expect(mockSourceNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
		);
		expect(mockAudioContext.createChannelSplitter).not.toHaveBeenCalled();
		expect(mockAudioContext.createGain).not.toHaveBeenCalled();
	});

	it('routes the left channel through a splitter', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-left',
			44100,
		);

		await bridge.start();

		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(2);
		expect(mockSourceNode.connect).toHaveBeenCalledWith(mockSplitterNode);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('routes the right channel through a splitter', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-right',
			44100,
		);

		await bridge.start();

		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			1,
			0,
		);
	});

	it('clamps a right pick to channel 0 for a mono track', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(1),
			'mono-right',
			44100,
		);

		await bridge.start();

		// Never routes from a silent padded splitter output
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('sizes the splitter for sources with more than two channels', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(4),
			'mono-right',
			44100,
		);

		await bridge.start();

		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(4);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			1,
			0,
		);
	});

	it('falls back to the source node channel count when track settings are silent', async () => {
		mockSourceNode.channelCount = 1;
		const bridge = new MonoCaptureBridge(
			createMockStream(undefined),
			'mono-right',
			44100,
		);

		await bridge.start();

		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('awaits the resume of a suspended context before recording', async () => {
		mockAudioContext.state = 'suspended';
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		await bridge.start();

		expect(mockAudioContext.resume).toHaveBeenCalled();
		// The graph was built only after the context reached running
		expect(mockSourceNode.connect).toHaveBeenCalled();
	});

	it('fails the start when the context stays suspended after resume', async () => {
		mockAudioContext.state = 'suspended';
		mockAudioContext.resume.mockImplementation(() => Promise.resolve());
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		// A silently suspended context would record a silent file while
		// the level meter (on the raw stream) keeps showing signal
		await expect(bridge.start()).rejects.toThrow(
			'recording would be silent',
		);
		expect(mockAudioContext.close).toHaveBeenCalled();
		expect(mockAudioContext.createMediaStreamSource).not.toHaveBeenCalled();
	});

	it('fails the start and releases when the resume itself rejects', async () => {
		mockAudioContext.state = 'suspended';
		mockAudioContext.resume.mockRejectedValue(new Error('resume failed'));
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		await expect(bridge.start()).rejects.toThrow('resume failed');
		expect(mockAudioContext.close).toHaveBeenCalled();
	});

	it('releases the graph, stops bridged tracks, and closes the context', async () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);
		await bridge.start();

		bridge.release();

		expect(mockSourceNode.disconnect).toHaveBeenCalled();
		expect(mockSplitterNode.disconnect).toHaveBeenCalled();
		expect(mockGainNode.disconnect).toHaveBeenCalled();
		expect(destinationTrackStop).toHaveBeenCalled();
		expect(mockAudioContext.close).toHaveBeenCalled();
	});

	it('releases acquired resources when the graph setup fails', async () => {
		mockAudioContext.createMediaStreamDestination.mockImplementation(() => {
			throw new Error('destination failed');
		});
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		await expect(bridge.start()).rejects.toThrow('destination failed');
		expect(mockAudioContext.close).toHaveBeenCalled();
	});

	it('never throws when the context close fails during release', async () => {
		jest.spyOn(console, 'warn').mockImplementation();
		mockAudioContext.close.mockRejectedValue(new Error('close failed'));
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);
		await bridge.start();

		expect(() => bridge.release()).not.toThrow();
	});

	it('is safe to release before start', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		expect(() => bridge.release()).not.toThrow();
	});
});
