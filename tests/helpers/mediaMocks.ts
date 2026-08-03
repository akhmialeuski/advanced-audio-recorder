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
 * An audio element double whose metadata load a test drives by hand.
 *
 * jsdom loads no media, so anything reading a duration through an element gets
 * one of these instead: the test decides what the element reports and when,
 * which is the only way to play out the sequence a streamed container produces
 * (metadata first with no length, the real one only after a seek).
 */
export class AudioElementDouble {
	preload = '';
	src = '';
	duration = Number.NaN;
	/** Whether the source was released, which every probe owes its element. */
	released = false;
	/** Makes the seek throw, as a source that refuses one does. */
	seekRejects = false;
	private seekTarget: number | null = null;
	private readonly listeners = new Map<string, Set<() => void>>();

	get currentTime(): number {
		return this.seekTarget ?? 0;
	}

	set currentTime(value: number) {
		if (this.seekRejects) {
			throw new Error('seek refused');
		}
		this.seekTarget = value;
	}

	/** Where the probe seeked to, or null when it never seeked. */
	get seekedTo(): number | null {
		return this.seekTarget;
	}

	/** Listeners still attached, so a settled probe can be shown to leak none. */
	get attachedListenerCount(): number {
		let count = 0;
		for (const handlers of this.listeners.values()) {
			count += handlers.size;
		}
		return count;
	}

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	removeAttribute(name: string): void {
		if (name === 'src') {
			this.released = true;
		}
	}

	load(): void {
		/* mirrors the teardown a probe performs */
	}

	/** Fires an event the element would have fired itself. */
	emit(type: string): void {
		for (const handler of [...(this.listeners.get(type) ?? [])]) {
			handler();
		}
	}
}

/**
 * Installs an Audio constructor returning {@link AudioElementDouble}s.
 * @param respond - Scripts each element, for a test that does not hold the
 * probe open to drive it by hand. Called on the microtask after construction,
 * because a probe attaches its listeners only once the constructor has
 * returned, so an event fired any earlier would reach nobody.
 * @returns Handle with created instances and a restore function
 */
export function installAudioElementMock(
	respond?: (audio: AudioElementDouble) => void,
): InstalledMock<AudioElementDouble> {
	const previous = (globalThis as { Audio?: unknown }).Audio;
	const instances: AudioElementDouble[] = [];
	(globalThis as { Audio?: unknown }).Audio = function AudioMock(
		this: AudioElementDouble,
	) {
		const element = new AudioElementDouble();
		instances.push(element);
		if (respond) {
			queueMicrotask(() => {
				respond(element);
			});
		}
		return element;
	};
	return {
		instances,
		restore: () => {
			(globalThis as { Audio?: unknown }).Audio = previous;
		},
	};
}

/** The object URLs a test handed out, and which of them were released. */
export interface ObjectUrlDouble {
	/** Every URL created, in order. */
	created: string[];
	/** Every URL revoked, in order. */
	revoked: string[];
}

/**
 * Installs URL.createObjectURL/revokeObjectURL, which jsdom does not provide.
 * Tracking both halves is what lets a test assert that a probe releases the
 * blob it made, however the probe ended.
 * @returns Handle whose single instance records the URLs
 */
export function installObjectUrlMock(): InstalledMock<ObjectUrlDouble> {
	const record: ObjectUrlDouble = { created: [], revoked: [] };
	const previousCreate = URL.createObjectURL as unknown;
	const previousRevoke = URL.revokeObjectURL as unknown;
	URL.createObjectURL = jest.fn(() => {
		const url = `blob:test/${String(record.created.length)}`;
		record.created.push(url);
		return url;
	});
	URL.revokeObjectURL = jest.fn((url: string) => {
		record.revoked.push(url);
	});
	return {
		instances: [record],
		restore: () => {
			URL.createObjectURL = previousCreate as typeof URL.createObjectURL;
			URL.revokeObjectURL = previousRevoke as typeof URL.revokeObjectURL;
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
