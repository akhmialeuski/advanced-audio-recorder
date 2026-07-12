/**
 * Unit tests for MonoCaptureBridge: the Web Audio graph that feeds
 * MediaRecorder-based recordings a mono stream.
 * @module tests/unit/MonoCaptureBridge.test
 */

import { MonoCaptureBridge } from 'src/recording/MonoCaptureBridge';

interface NodeDouble {
	connect: jest.Mock;
	disconnect: jest.Mock;
	channelCount?: number;
}

let mockSourceNode: NodeDouble & { channelCount: number };
let mockSplitterNode: NodeDouble;
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
};

function createMockStream(channelCount?: number): MediaStream {
	return {
		getAudioTracks: () => [
			{
				stop: jest.fn(),
				getSettings: () => ({ channelCount }),
			},
		],
		getTracks: () => [{ stop: jest.fn() }],
	} as unknown as MediaStream;
}

beforeEach(() => {
	jest.clearAllMocks();
	mockSourceNode = {
		connect: jest.fn(),
		disconnect: jest.fn(),
		channelCount: 2,
	};
	mockSplitterNode = { connect: jest.fn(), disconnect: jest.fn() };
	destinationTrackStop = jest.fn();
	mockDestinationNode = {
		channelCount: 2,
		channelCountMode: 'explicit',
		channelInterpretation: 'speakers',
		stream: {
			getTracks: () => [{ stop: destinationTrackStop }],
		} as unknown as MediaStream,
		disconnect: jest.fn(),
	};
	mockAudioContext = {
		state: 'running',
		resume: jest.fn().mockResolvedValue(undefined),
		close: jest.fn().mockResolvedValue(undefined),
		createMediaStreamSource: jest.fn().mockReturnValue(mockSourceNode),
		createMediaStreamDestination: jest
			.fn()
			.mockReturnValue(mockDestinationNode),
		createChannelSplitter: jest.fn().mockReturnValue(mockSplitterNode),
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

	it('builds the mix graph through the one-channel destination', () => {
		const stream = createMockStream(2);
		const bridge = new MonoCaptureBridge(stream, 'mono-mix', 48000);

		const monoStream = bridge.start();

		expect(global.AudioContext).toHaveBeenCalledWith({
			sampleRate: 48000,
		});
		expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalledWith(
			stream,
		);
		expect(mockDestinationNode.channelCount).toBe(1);
		expect(mockDestinationNode.channelCountMode).toBe('explicit');
		expect(mockDestinationNode.channelInterpretation).toBe('speakers');
		expect(mockSourceNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
		);
		expect(mockAudioContext.createChannelSplitter).not.toHaveBeenCalled();
		expect(monoStream).toBe(mockDestinationNode.stream);
	});

	it('routes the left channel through a splitter', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-left',
			44100,
		);

		bridge.start();

		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(2);
		expect(mockSourceNode.connect).toHaveBeenCalledWith(mockSplitterNode);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('routes the right channel through a splitter', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-right',
			44100,
		);

		bridge.start();

		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			1,
			0,
		);
	});

	it('clamps a right pick to channel 0 for a mono track', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(1),
			'mono-right',
			44100,
		);

		bridge.start();

		// Never routes from a silent padded splitter output
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('sizes the splitter for sources with more than two channels', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(4),
			'mono-right',
			44100,
		);

		bridge.start();

		expect(mockAudioContext.createChannelSplitter).toHaveBeenCalledWith(4);
		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			1,
			0,
		);
	});

	it('falls back to the source node channel count when track settings are silent', () => {
		mockSourceNode.channelCount = 1;
		const bridge = new MonoCaptureBridge(
			createMockStream(undefined),
			'mono-right',
			44100,
		);

		bridge.start();

		expect(mockSplitterNode.connect).toHaveBeenCalledWith(
			mockDestinationNode,
			0,
			0,
		);
	});

	it('resumes a suspended context', () => {
		mockAudioContext.state = 'suspended';
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		bridge.start();

		expect(mockAudioContext.resume).toHaveBeenCalled();
	});

	it('releases the graph, stops bridged tracks, and closes the context', () => {
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-left',
			44100,
		);
		bridge.start();

		bridge.release();

		expect(mockSourceNode.disconnect).toHaveBeenCalled();
		expect(mockSplitterNode.disconnect).toHaveBeenCalled();
		expect(destinationTrackStop).toHaveBeenCalled();
		expect(mockAudioContext.close).toHaveBeenCalled();
	});

	it('releases acquired resources when the graph setup fails', () => {
		mockAudioContext.createMediaStreamDestination.mockImplementation(() => {
			throw new Error('destination failed');
		});
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);

		expect(() => bridge.start()).toThrow('destination failed');
		expect(mockAudioContext.close).toHaveBeenCalled();
	});

	it('never throws when the context close fails during release', () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
		mockAudioContext.close.mockRejectedValue(new Error('close failed'));
		const bridge = new MonoCaptureBridge(
			createMockStream(2),
			'mono-mix',
			44100,
		);
		bridge.start();

		expect(() => bridge.release()).not.toThrow();
		warnSpy.mockRestore();
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
