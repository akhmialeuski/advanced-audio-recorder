/**
 * Media-API doubles (MediaRecorder, AudioContext, getUserMedia) with
 * paired cleanup, so suites stop hand-rolling globals and leaking them
 * into each other.
 * @module tests/helpers/mediaMocks
 */

/** A MediaRecorder double exposing its event hooks for tests. */
export interface MediaRecorderDouble {
	start: jest.Mock;
	stop: jest.Mock;
	pause: jest.Mock;
	resume: jest.Mock;
	state: string;
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null;
	onstop: (() => void) | null;
	onerror: ((event: unknown) => void) | null;
}

/** Handle returned by the install helpers; restore() undoes the global. */
export interface InstalledMock<T> {
	instances: T[];
	restore: () => void;
}

/**
 * Installs a MediaRecorder double on globalThis. Each construction is
 * captured in `instances`; stop() fires onstop on the next microtask.
 * @param options - Optional overrides (e.g. isTypeSupported)
 * @returns Handle with created instances and a restore function
 */
export function installMediaRecorderMock(
	options: { isTypeSupported?: (type: string) => boolean } = {},
): InstalledMock<MediaRecorderDouble> {
	const previous = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
	const instances: MediaRecorderDouble[] = [];

	const MediaRecorderMock = jest.fn(function (
		this: MediaRecorderDouble,
		_stream: MediaStream,
		init?: { mimeType?: string },
	) {
		this.state = 'inactive';
		this.mimeType = init?.mimeType ?? 'audio/webm';
		this.ondataavailable = null;
		this.onstop = null;
		this.onerror = null;
		this.start = jest.fn(() => {
			this.state = 'recording';
		});
		this.pause = jest.fn(() => {
			this.state = 'paused';
		});
		this.resume = jest.fn(() => {
			this.state = 'recording';
		});
		this.stop = jest.fn(() => {
			this.state = 'inactive';
			queueMicrotask(() => this.onstop?.());
		});
		instances.push(this);
	}) as unknown as typeof MediaRecorder & {
		isTypeSupported: jest.Mock;
	};
	MediaRecorderMock.isTypeSupported = jest.fn(
		options.isTypeSupported ?? (() => true),
	);

	(globalThis as { MediaRecorder?: unknown }).MediaRecorder =
		MediaRecorderMock;

	return {
		instances,
		restore: () => {
			(globalThis as { MediaRecorder?: unknown }).MediaRecorder =
				previous;
		},
	};
}

/** An AudioContext double exposing the commonly probed surface. */
export interface AudioContextDouble {
	sampleRate: number;
	state: string;
	close: jest.Mock;
	decodeAudioData: jest.Mock;
	createMediaStreamSource: jest.Mock;
	createGain: jest.Mock;
	createAnalyser: jest.Mock;
	destination: object;
	audioWorklet: { addModule: jest.Mock };
}

/**
 * Installs an AudioContext double on globalThis (and window when
 * present).
 * @param options - Optional sample rate and decode result factory
 * @returns Handle with created instances and a restore function
 */
export function installAudioContextMock(
	options: {
		sampleRate?: number;
		decodeAudioData?: jest.Mock;
	} = {},
): InstalledMock<AudioContextDouble> {
	const previous = (globalThis as { AudioContext?: unknown }).AudioContext;
	const instances: AudioContextDouble[] = [];

	const AudioContextMock = jest.fn(function (
		this: AudioContextDouble,
		init?: { sampleRate?: number },
	) {
		this.sampleRate = init?.sampleRate ?? options.sampleRate ?? 44100;
		this.state = 'running';
		this.close = jest.fn(() => {
			this.state = 'closed';
			return Promise.resolve();
		});
		this.decodeAudioData =
			options.decodeAudioData ??
			jest.fn().mockRejectedValue(new Error('decode not stubbed'));
		this.createMediaStreamSource = jest.fn(() => ({
			connect: jest.fn(),
			disconnect: jest.fn(),
			channelCount: 1,
		}));
		this.createGain = jest.fn(() => ({
			gain: { value: 1 },
			connect: jest.fn(),
			disconnect: jest.fn(),
		}));
		this.createAnalyser = jest.fn(() => ({
			fftSize: 2048,
			connect: jest.fn(),
			disconnect: jest.fn(),
			getFloatTimeDomainData: jest.fn(),
		}));
		this.destination = {};
		this.audioWorklet = {
			addModule: jest.fn().mockResolvedValue(undefined),
		};
		instances.push(this);
	});

	(globalThis as { AudioContext?: unknown }).AudioContext = AudioContextMock;

	return {
		instances,
		restore: () => {
			(globalThis as { AudioContext?: unknown }).AudioContext = previous;
		},
	};
}

/**
 * Installs navigator.mediaDevices.getUserMedia returning the given
 * stream (or a minimal stub).
 * @param stream - Stream to resolve with; a stub is built when omitted
 * @returns Handle whose single instance is the getUserMedia mock
 */
export function installGetUserMediaMock(
	stream?: MediaStream,
): InstalledMock<jest.Mock> {
	const resolved =
		stream ??
		({
			getTracks: () => [{ stop: jest.fn() }],
			getAudioTracks: () => [{ stop: jest.fn() }],
		} as unknown as MediaStream);
	const getUserMedia = jest.fn().mockResolvedValue(resolved);
	const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
	Object.defineProperty(navigator, 'mediaDevices', {
		value: {
			getUserMedia,
			enumerateDevices: jest.fn().mockResolvedValue([]),
		},
		configurable: true,
	});
	return {
		instances: [getUserMedia],
		restore: () => {
			if (previous) {
				Object.defineProperty(navigator, 'mediaDevices', previous);
			} else {
				delete (navigator as { mediaDevices?: unknown }).mediaDevices;
			}
		},
	};
}
