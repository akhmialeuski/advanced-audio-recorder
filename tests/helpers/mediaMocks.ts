/**
 * Media-API doubles with paired cleanup, so suites stop hand-rolling globals
 * and leaking them into each other.
 *
 * Covers the HTMLAudioElement, object URLs, and the realtime audio graph the
 * live playback chain is wired in. It once also carried MediaRecorder and
 * getUserMedia doubles, which no test ever used - the suites that needed them
 * had installed their own before these were written. Removed rather than left
 * as a second way to do it.
 * @module tests/helpers/mediaMocks
 */

import { at } from './assertions';
import { globals } from './doubles';

/** Handle returned by the install helpers; restore() undoes the global. */
export interface InstalledMock<T> {
	instances: T[];
	restore: () => void;
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

/** One AudioContext the double handed out, as a test reads it back. */
export interface AudioContextDouble {
	/** The rate this context reports, which is the device's own. */
	sampleRate: number;
	/** Whether the plugin released it. */
	closed: boolean;
}

/**
 * Installs an AudioContext that only reports a sample rate.
 *
 * Every bitrate floor in the plugin is taken at the rate an offline encode
 * runs at, and that is the rate the audio hardware provides rather than the
 * one the settings ask for. A suite about a floor therefore has to say which
 * machine it is on, and four of them said it by hand-rolling this same
 * constructor. The instances are recorded so a test can also assert how many
 * contexts were opened, which is what keeps the reading memoised.
 * @param sampleRate - The rate the device runs at
 * @param close - What closing the context does, for the failure path
 * @returns Handle whose instances are the contexts that were constructed
 */
export function installAudioContextRate(
	sampleRate: number,
	close: () => Promise<void> = () => Promise.resolve(),
): InstalledMock<AudioContextDouble> {
	const instances: AudioContextDouble[] = [];
	const previous = (global as Record<string, unknown>)['AudioContext'];
	(global as Record<string, unknown>)['AudioContext'] = jest.fn(() => {
		const context: AudioContextDouble = { sampleRate, closed: false };
		instances.push(context);
		return {
			sampleRate,
			close: (): Promise<void> => {
				context.closed = true;
				return close();
			},
		};
	});
	return {
		instances,
		restore: () => {
			if (previous === undefined) {
				delete (global as Record<string, unknown>)['AudioContext'];
				return;
			}
			(global as Record<string, unknown>)['AudioContext'] = previous;
		},
	};
}

/** One parameter of a graph node, as the tests read and schedule it. */
export interface AudioParamDouble {
	/** Value written straight onto the parameter. */
	value: number;
	/** Every setTargetAtTime schedule, in order. */
	scheduled: Array<{ value: number; time: number; timeConstant: number }>;
	/**
	 * Records the schedule and moves the value to the target it aims at. The
	 * ramp is not modelled, only where it lands, which is what lets a test
	 * tell a parameter the plugin drove from one it left at its default.
	 */
	setTargetAtTime(value: number, time: number, timeConstant: number): void;
}

/**
 * One node the plugin put in an audio graph.
 *
 * Everything a node can be is on one shape rather than one class per node
 * kind: a test that inspects a chain reads the same fields whichever node it
 * lands on, and the members that do not apply stay inert.
 */
export interface AudioNodeDouble {
	/** The kind of node, as the plugin asked for it. */
	kind: string;
	/** Nodes this one currently feeds. */
	outputs: AudioNodeDouble[];
	/** Times it was disconnected, which is what drops its outputs. */
	disconnects: number;
	/** Parameters it exposes, by name; empty for a node without any. */
	parameters: Record<string, AudioParamDouble>;
	/** FFT window of an analyser, zero for every other kind. */
	fftSize: number;
	/** Fills a buffer with the level the test asked for; inert off an analyser. */
	getFloatTimeDomainData(buffer: Float32Array): void;
	connect(target: AudioNodeDouble): AudioNodeDouble;
	disconnect(): void;
}

/** The audio context the plugin opened, and everything wired through it. */
export interface AudioGraphContextDouble {
	/** The rate the context reports. */
	sampleRate: number;
	/** Whether the plugin closed it. */
	closed: boolean;
	/** Times the plugin asked it to run. */
	resumes: number;
	/** Every node created in it, in the order created. */
	nodes: AudioNodeDouble[];
	/** The node each element was routed through, in the order routed. */
	sources: Array<{ element: HTMLMediaElement; node: AudioNodeDouble }>;
	/** The context's own output, which everything audible has to reach. */
	destination: AudioNodeDouble;
	/** Amplitude the analyser reports, which is the level a test sets. */
	analyserAmplitude: number;
}

/**
 * Builds one parameter of a node.
 * @param initial - The value the platform starts it at, 0 where it has none
 */
function audioParamDouble(initial = 0): AudioParamDouble {
	const parameter: AudioParamDouble = {
		value: initial,
		scheduled: [],
		setTargetAtTime(value, time, timeConstant) {
			parameter.scheduled.push({ value, time, timeConstant });
			parameter.value = value;
		},
	};
	return parameter;
}

/**
 * Builds one node of a graph and records it on its context.
 * @param kind - The kind of node, as the plugin asked for it
 * @param parameterDefaults - Each parameter and the value the platform starts
 *   it at, which a test asserts an untouched parameter still holds
 * @param context - The context the node belongs to
 */
function nodeDouble(
	kind: string,
	parameterDefaults: Record<string, number>,
	context: AudioGraphContextDouble,
): AudioNodeDouble {
	const parameters: Record<string, AudioParamDouble> = {};
	for (const [name, initial] of Object.entries(parameterDefaults)) {
		parameters[name] = audioParamDouble(initial);
	}
	const node: AudioNodeDouble = {
		kind,
		outputs: [],
		disconnects: 0,
		parameters,
		fftSize: 0,
		getFloatTimeDomainData(buffer) {
			buffer.fill(context.analyserAmplitude);
		},
		connect(target) {
			node.outputs.push(target);
			return target;
		},
		disconnect() {
			node.disconnects += 1;
			node.outputs.length = 0;
		},
	};
	// The plugin reads a parameter the way the platform exposes it - as
	// `node.frequency`, `node.gain` - so the same objects are placed on the
	// node itself as well as in the map a test reads them back through.
	Object.assign(node, parameters);
	context.nodes.push(node);
	return node;
}

/**
 * A realtime audio context that records what was wired through it.
 *
 * Built as a class whose own prototype carries the node factories, because
 * the plugin decides whether to offer the live chain by probing that prototype
 * - the way it has to, since the answer gates a control long before anything
 * is played. Routing an element twice throws the way the platform does: a
 * media element can be taken into a graph once, and a test that proves the
 * plugin never rebuilds a graph needs the double to refuse it too.
 * @param sampleRate - The rate this context reports to the plugin
 * @param instances - Collects every context built, as the install hands them out
 */
function audioGraphContextClass(
	sampleRate: number,
	instances: AudioGraphContextDouble[],
): new () => AudioGraphContextDouble {
	return class AudioGraphContextMock implements AudioGraphContextDouble {
		readonly sampleRate = sampleRate;
		readonly nodes: AudioNodeDouble[] = [];
		readonly sources: Array<{
			element: HTMLMediaElement;
			node: AudioNodeDouble;
		}> = [];
		readonly destination: AudioNodeDouble;
		/** The double has no clock; what a test reads is what was scheduled. */
		readonly currentTime = 0;
		closed = false;
		resumes = 0;
		analyserAmplitude = 0;

		constructor() {
			// Created before anything can connect to it, so it is the last node
			// of every chain and nothing else has to be assigned first
			this.destination = nodeDouble('destination', {}, this);
			instances.push(this);
		}

		createMediaElementSource(element: HTMLMediaElement): AudioNodeDouble {
			if (this.sources.some((entry) => entry.element === element)) {
				throw new DOMException(
					'this element is already routed into a graph',
					'InvalidStateError',
				);
			}
			const node = nodeDouble('source', {}, this);
			this.sources.push({ element, node });
			return node;
		}

		createBiquadFilter(): AudioNodeDouble {
			// The platform's own defaults, so a test can tell a parameter the
			// plugin left alone from one it set: a BiquadFilterNode starts at
			// 350 Hz with a Q of 1
			return nodeDouble(
				'biquad',
				{ frequency: 350, Q: 1, gain: 0 },
				this,
			);
		}

		createGain(): AudioNodeDouble {
			// A GainNode starts at unity, so an untouched one passes the
			// signal through rather than silencing it
			return nodeDouble('gain', { gain: 1 }, this);
		}

		createAnalyser(): AudioNodeDouble {
			const node = nodeDouble('analyser', {}, this);
			node.fftSize = 2048;
			return node;
		}

		createDynamicsCompressor(): AudioNodeDouble {
			return nodeDouble(
				'compressor',
				{
					threshold: 0,
					knee: 0,
					ratio: 0,
					attack: 0,
					release: 0,
				},
				this,
			);
		}

		close(): Promise<void> {
			this.closed = true;
			return Promise.resolve();
		}

		resume(): Promise<void> {
			this.resumes += 1;
			return Promise.resolve();
		}
	};
}

/**
 * Installs the audio context every Web Audio path is built against, recording
 * the nodes and the connections between them.
 *
 * Distinct from {@link installAudioContextRate}, which answers one question -
 * what rate does this device run at - for suites that never build a graph. A
 * suite that wires one needs to see the graph itself.
 * @param sampleRate - The rate the context reports, 48 kHz by default
 * @returns Handle whose instances are the contexts the plugin opened
 */
export function installAudioGraphMock(
	sampleRate = 48000,
): InstalledMock<AudioGraphContextDouble> {
	const instances: AudioGraphContextDouble[] = [];
	const scope = globals();
	const previous = scope['AudioContext'];
	scope['AudioContext'] = audioGraphContextClass(sampleRate, instances);
	return {
		instances,
		restore: () => {
			if (previous === undefined) {
				delete scope['AudioContext'];
				return;
			}
			scope['AudioContext'] = previous;
		},
	};
}

/**
 * The nodes one element's audio passes through, from its source to the
 * context's output. An analyser tap is left out: it hangs off the path with
 * nothing connected after it, so it is a meter rather than a stage.
 * @param context - The recorded context
 * @param audio - Element whose path is followed
 * @returns The path in order, or null where the element was never routed
 */
export function audioPathOf(
	context: AudioGraphContextDouble,
	audio: HTMLMediaElement,
): AudioNodeDouble[] | null {
	const source = context.sources.find((entry) => entry.element === audio);
	return source ? pathTo(context.destination, source.node, new Set()) : null;
}

/** Depth-first walk to the output, skipping the branches that lead nowhere. */
function pathTo(
	destination: AudioNodeDouble,
	node: AudioNodeDouble,
	seen: Set<AudioNodeDouble>,
): AudioNodeDouble[] | null {
	if (node === destination) {
		return [node];
	}
	if (seen.has(node)) {
		return null;
	}
	seen.add(node);
	for (const next of node.outputs) {
		const rest = pathTo(destination, next, seen);
		if (rest) {
			return [node, ...rest];
		}
	}
	return null;
}

/**
 * The node of a kind, by the order the plugin created it in. A chain builds
 * two gain nodes - the gate and the makeup stage behind it - so the index is
 * how they are told apart.
 * @param context - The recorded context
 * @param kind - Kind of node to find
 * @param index - Which one of that kind, in creation order
 * @returns The recorded node
 */
export function nodeOfKind(
	context: AudioGraphContextDouble,
	kind: string,
	index = 0,
): AudioNodeDouble {
	const found = context.nodes.filter((node) => node.kind === kind);
	return at(found, index, `the ${kind} node at index ${String(index)}`);
}

/**
 * Builds a `MediaDeviceInfo` the way the browser reports one.
 *
 * Eight suites hand-rolled this five-field literal, always with the same
 * `toJSON` stub the DOM type demands and no test ever reads. Naming the two
 * fields that matter - the id and the label - keeps a device list readable.
 * @param deviceId - Device id the browser reports
 * @param label - Human-readable name, defaults to the id
 * @param kind - Device kind, defaulting to a microphone
 * @returns The device descriptor
 */
export function mediaDevice(
	deviceId: string,
	label: string = deviceId,
	kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
	return {
		deviceId,
		label,
		kind,
		groupId: `group-${deviceId}`,
		toJSON: () => ({}),
	};
}

/**
 * Puts a `navigator.mediaDevices` double in place for every test of the
 * calling suite, and puts the real one back afterwards.
 *
 * Call it in the describe body; it registers both hooks. jsdom ships no media
 * devices, so every suite that touches an input has to install its own, and
 * every one of them wrote the same defineProperty pair by hand - which is
 * where a leaked global comes from, since the restore is a convention rather
 * than a guarantee. Pairing them here means the restore cannot be forgotten.
 * @param build - Builds the MediaDevices members this suite needs, per test
 * @returns Reads the double the current test is running against
 */
export function withMediaDevices<T extends object>(build: () => T): () => T {
	const original = navigator.mediaDevices;
	let current: T;
	beforeEach(() => {
		current = build();
		Object.defineProperty(navigator, 'mediaDevices', {
			value: current,
			configurable: true,
		});
	});
	afterEach(() => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: original,
			configurable: true,
		});
	});
	return () => current;
}

/** The device id the browser uses for the system default input. */
export const DEFAULT_DEVICE_ID = 'default';

/**
 * The stock device list: a system default microphone plus a named second one.
 * @returns Two audio inputs, the first of them the system default
 */
export function defaultDeviceList(): MediaDeviceInfo[] {
	return [
		mediaDevice(DEFAULT_DEVICE_ID, 'Default - Microphone'),
		mediaDevice('device1', 'Microphone 1'),
	];
}

/** A real audio element whose playback state a test drives. */
export interface ControlledAudio {
	/** The element itself, ready to hand to the code under test. */
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	load: jest.SpyInstance<void, []>;
	/** How many times `new Audio()` was called, for a SUT that builds its own. */
	constructions: () => number;
	/** Moves the playhead and fires the timeupdate that follows it. */
	advanceTo: (seconds: number) => void;
	/** Reports a new length and fires durationchange, as a stream does. */
	setDuration: (seconds: number) => void;
	/** Sets readyState; 1 is "metadata is in", 0 is "nothing yet". */
	setReadyState: (value: number) => void;
	/** Marks metadata as arrived and fires loadedmetadata. */
	loadMetadata: () => void;
	/** Makes play() reject, the way a browser blocking autoplay does. */
	blockAutoplay: () => void;
}

/** What a suite varies about the element it plays through. */
export interface ControlledAudioOptions {
	/** Length the element reports. */
	duration?: number;
	/** Initial readyState; 0 models an element whose metadata has not landed. */
	readyState?: number;
	/** Whether `new Audio()` should hand back this element. */
	asConstructor?: boolean;
}

/**
 * Builds an audio element that actually behaves like one.
 *
 * jsdom implements no media: `play()` does nothing, `paused` never changes,
 * `duration` is NaN. Five suites each grew the same answer to that - property
 * stubs over the element plus spies that flip them and fire the matching event
 * - which is one double, not five.
 *
 * Nothing needs restoring afterwards: the element is built per call and thrown
 * away, and the one global touched is the Audio constructor, which the
 * projects' `restoreMocks` puts back.
 * @param options - Length, readiness, and whether it stands in for `new Audio`
 * @returns The element and the controls a test drives it with
 */
export function installControlledAudio(
	options: ControlledAudioOptions = {},
): ControlledAudio {
	const { duration = 120, readyState = 1, asConstructor = true } = options;
	const audio = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	let ready = readyState;
	let length = duration;
	let autoplayBlocked = false;
	Object.defineProperties(audio, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => length },
		readyState: { configurable: true, get: () => ready },
	});
	const play = jest.spyOn(audio, 'play').mockImplementation(() => {
		if (autoplayBlocked) {
			return Promise.reject(new Error('autoplay blocked'));
		}
		paused = false;
		audio.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	const pause = jest.spyOn(audio, 'pause').mockImplementation(() => {
		paused = true;
		audio.dispatchEvent(new Event('pause'));
	});
	const load = jest.spyOn(audio, 'load').mockImplementation(() => undefined);
	const factory = asConstructor
		? jest.spyOn(globalThis, 'Audio').mockImplementation(() => audio)
		: null;

	return {
		audio,
		play,
		pause,
		load,
		constructions: () => factory?.mock.calls.length ?? 0,
		advanceTo: (seconds) => {
			currentTime = seconds;
			audio.dispatchEvent(new Event('timeupdate'));
		},
		setDuration: (seconds) => {
			length = seconds;
			audio.dispatchEvent(new Event('durationchange'));
		},
		setReadyState: (value) => {
			ready = value;
		},
		loadMetadata: () => {
			ready = 1;
			audio.dispatchEvent(new Event('loadedmetadata'));
		},
		blockAutoplay: () => {
			autoplayBlocked = true;
		},
	};
}
