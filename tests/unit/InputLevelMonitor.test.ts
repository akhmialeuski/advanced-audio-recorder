/**
 * Tests the audio-graph half of the input level meter.
 *
 * The RMS and dB maths were already covered; the class that wraps them was not,
 * which left the branches that matter in practice untested: a context the
 * browser starts suspended until a user gesture, a constructor that throws
 * because the tab has no audio permission, and the guarantee that the input is
 * never routed to the speakers.
 * @module tests/unit/InputLevelMonitor.test
 */

import { InputLevelMonitor } from 'src/recording/InputLevelMonitor';

/** The audio graph the monitor builds, with every node a spy. */
interface AudioGraphDouble {
	context: {
		state: AudioContextState;
		resume: jest.Mock;
		close: jest.Mock;
		createMediaStreamSource: jest.Mock;
		createAnalyser: jest.Mock;
	};
	source: { connect: jest.Mock; disconnect: jest.Mock };
	analyser: { fftSize: number; getFloatTimeDomainData: jest.Mock };
	restore: () => void;
}

/**
 * Installs an AudioContext double for the current test.
 * @param options - How the context should behave when it is built
 * @returns The graph the monitor will construct
 */
function installAudioGraph(
	options: {
		state?: AudioContextState;
		resume?: jest.Mock;
		close?: jest.Mock;
		throwOnConstruct?: boolean;
	} = {},
): AudioGraphDouble {
	const source = { connect: jest.fn(), disconnect: jest.fn() };
	const analyser = {
		fftSize: 2048,
		getFloatTimeDomainData: jest.fn(),
	};
	const context = {
		state: options.state ?? 'running',
		resume: options.resume ?? jest.fn().mockResolvedValue(undefined),
		close: options.close ?? jest.fn().mockResolvedValue(undefined),
		createMediaStreamSource: jest.fn(() => source),
		createAnalyser: jest.fn(() => analyser),
	};
	const original = (globalThis as { AudioContext?: unknown }).AudioContext;
	(globalThis as { AudioContext?: unknown }).AudioContext = jest.fn(() => {
		if (options.throwOnConstruct) {
			throw new Error('no audio permission');
		}
		return context;
	});
	return {
		context,
		source,
		analyser,
		restore: () => {
			(globalThis as { AudioContext?: unknown }).AudioContext = original;
		},
	};
}

const stream = {} as MediaStream;

describe('InputLevelMonitor.start', () => {
	let graph: AudioGraphDouble;

	afterEach(() => {
		graph.restore();
	});

	it('taps the stream through an analyser', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();

		monitor.start(stream);

		expect(graph.context.createMediaStreamSource).toHaveBeenCalledWith(
			stream,
		);
		expect(graph.source.connect).toHaveBeenCalledWith(graph.analyser);
	});

	it('never routes the input to the speakers', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();

		monitor.start(stream);

		// Connecting to the destination would play the microphone back
		// through it, which is a feedback loop in a room with no headphones.
		expect(graph.source.connect).toHaveBeenCalledTimes(1);
		expect(graph.source.connect).not.toHaveBeenCalledWith(
			expect.objectContaining({ maxChannelCount: expect.anything() }),
		);
	});

	it('sizes the analyser window so the meter has enough samples', () => {
		graph = installAudioGraph();

		new InputLevelMonitor().start(stream);

		expect(graph.analyser.fftSize).toBe(1024);
	});

	it('resumes a context the browser started suspended', () => {
		graph = installAudioGraph({ state: 'suspended' });

		new InputLevelMonitor().start(stream);

		// A context suspended until a user gesture would read pure silence.
		expect(graph.context.resume).toHaveBeenCalled();
	});

	it('leaves a running context alone', () => {
		graph = installAudioGraph({ state: 'running' });

		new InputLevelMonitor().start(stream);

		expect(graph.context.resume).not.toHaveBeenCalled();
	});

	it('carries on when the resume is refused', async () => {
		const resume = jest.fn().mockRejectedValue(new Error('blocked'));
		graph = installAudioGraph({ state: 'suspended', resume });
		const monitor = new InputLevelMonitor();

		monitor.start(stream);
		await Promise.resolve();

		// Non-fatal: the meter reads zero rather than the recording failing.
		expect(monitor.getLevel()).toBe(0);
	});

	it('reports a graph it could not build and stays at zero', () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		graph = installAudioGraph({ throwOnConstruct: true });
		const monitor = new InputLevelMonitor();

		monitor.start(stream);

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Could not start input level monitor'),
			expect.any(Error),
		);
		expect(monitor.getLevel()).toBe(0);
	});
});

describe('InputLevelMonitor.getLevel', () => {
	let graph: AudioGraphDouble;

	afterEach(() => {
		graph.restore();
	});

	it('is zero before the monitor is started', () => {
		graph = installAudioGraph();

		expect(new InputLevelMonitor().getLevel()).toBe(0);
	});

	it('is zero after the monitor is stopped', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		monitor.stop();

		expect(monitor.getLevel()).toBe(0);
	});

	it.each([
		{ name: 'silence', amplitude: 0, expected: 0 },
		{ name: 'full scale', amplitude: 1, expected: 1 },
	])('reads $name as $expected', ({ amplitude, expected }) => {
		graph = installAudioGraph();
		graph.analyser.getFloatTimeDomainData.mockImplementation(
			(buffer: Float32Array) => {
				buffer.fill(amplitude);
			},
		);
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		expect(monitor.getLevel()).toBe(expected);
	});

	it('reads a quiet signal as something visible but well below full', () => {
		graph = installAudioGraph();
		graph.analyser.getFloatTimeDomainData.mockImplementation(
			(buffer: Float32Array) => {
				buffer.fill(0.01);
			},
		);
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		const level = monitor.getLevel();

		// -40 dBFS on a -60 dB floor: a third of the way up, not invisible.
		expect(level).toBeGreaterThan(0.2);
		expect(level).toBeLessThan(0.5);
	});
});

describe('InputLevelMonitor.stop', () => {
	let graph: AudioGraphDouble;

	afterEach(() => {
		graph.restore();
	});

	it('releases the graph', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		monitor.stop();

		expect(graph.source.disconnect).toHaveBeenCalled();
		expect(graph.context.close).toHaveBeenCalled();
	});

	it('is safe to call before the monitor was ever started', () => {
		graph = installAudioGraph();

		expect(() => {
			new InputLevelMonitor().stop();
		}).not.toThrow();
	});

	it('is safe to call twice', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		monitor.stop();

		expect(() => {
			monitor.stop();
		}).not.toThrow();
		expect(graph.context.close).toHaveBeenCalledTimes(1);
	});

	it('survives a node that is already disconnected', () => {
		graph = installAudioGraph();
		const monitor = new InputLevelMonitor();
		monitor.start(stream);
		graph.source.disconnect.mockImplementation(() => {
			throw new Error('already disconnected');
		});

		expect(() => {
			monitor.stop();
		}).not.toThrow();
	});

	it('survives a context that refuses to close', async () => {
		const close = jest.fn().mockRejectedValue(new Error('already closed'));
		graph = installAudioGraph({ close });
		const monitor = new InputLevelMonitor();
		monitor.start(stream);

		monitor.stop();
		await Promise.resolve();

		expect(close).toHaveBeenCalled();
	});
});
