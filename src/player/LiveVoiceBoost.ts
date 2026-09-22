/**
 * Live voice boost: the audio-cleanup chain wired into playback.
 *
 * Cleanup as a file operation decodes a whole recording and writes a cleaned
 * copy, which is why it costs seconds on a long file. The same stages applied
 * to a recording while it plays need no copy at all: each one is a Web Audio
 * node, so engaging the chain is a reconnection between the playing element
 * and the output, and releasing it is the reverse.
 *
 * Two platform facts shape this module. A media element can be routed into an
 * audio graph only once - a second `createMediaElementSource` on the same
 * element throws - so a graph, once built, outlives every toggle and is
 * rewired rather than rebuilt. And a routed element reaches the speakers only
 * through that graph, so the untouched path is a straight wire to the
 * destination: the one thing that must never happen is a disconnection.
 *
 * One realtime AudioContext serves every element. A context per element would
 * accumulate them, and browsers cap how many a page may open.
 * @module player/LiveVoiceBoost
 */

import {
	CLEANUP_GATE_ATTACK_MS,
	CLEANUP_GATE_HYSTERESIS_DB,
	CLEANUP_GATE_RELEASE_MS,
	CLEANUP_GATE_WINDOW_SECONDS,
	CLEANUP_LEVELING_ATTACK_SECONDS,
	CLEANUP_LEVELING_KNEE_DB,
	CLEANUP_LEVELING_RATIO,
	CLEANUP_LEVELING_RELEASE_SECONDS,
	CLEANUP_LEVELING_THRESHOLD_DB,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import { computeRms } from '../audio/pcm';
import {
	dbToGain,
	gateShouldOpen,
	hasActiveStage,
	voiceBoostStagesEqual,
	type VoiceBoostStages,
} from '../cleanup/audioDsp';

/** A constructor that builds a realtime audio graph, or nothing where none exists. */
type AudioContextConstructor = new () => AudioContext;

/**
 * Smallest analyser window, in samples, the gate will measure over. The FFT
 * size is rounded up to a power of two, and this is the floor that rounding
 * is held to.
 */
const MIN_GATE_WINDOW_SAMPLES = 32;

/** Largest FFT size an AnalyserNode accepts, and so the ceiling on the window. */
const MAX_GATE_WINDOW_SAMPLES = 32768;

/**
 * The graph built for one playing element: the nodes the chain is laid out
 * from, and the state that survives a rewire.
 */
interface VoiceBoostGraph {
	/** The element this graph was built on, and whose playback drives it. */
	element: HTMLMediaElement;
	/** The element's only route into Web Audio, created once and never again. */
	source: MediaElementAudioSourceNode;
	highPass: BiquadFilterNode;
	/** Gain the noise gate drives between silence and unity. */
	gate: GainNode;
	/** Taps the signal on its way into the gate to measure its level. */
	analyser: AnalyserNode;
	compressor: DynamicsCompressorNode;
	/** Gain applied after the compressor, which is the leveling setting. */
	makeup: GainNode;
	/** Whether the element's audio currently runs through the stages. */
	engaged: boolean;
	/** Interval driving the gate, or 0 while none runs. */
	gateTimer: number;
	/** Whether the gate is open, carried across reads for the hysteresis. */
	gateOpen: boolean;
	/** Reused buffer for one analyser read. */
	gateSamples: Float32Array<ArrayBuffer>;
	/** Removes the listeners that keep the gate's loop on the playback. */
	playbackEvents: AbortController;
}

/** Whether the live chain can be offered here, and whether it is engaged. */
export interface VoiceBoostState {
	/**
	 * Whether this runtime can host the chain at all. False hides the control
	 * rather than offering one that could not process anything.
	 */
	available: boolean;
	/** Whether the chain is currently applied to playback. */
	enabled: boolean;
	/**
	 * Whether the cleanup configuration has a stage to apply. A chain with
	 * none engages and routes the audio straight through, so the switch is
	 * honest about being on while nothing is being rendered.
	 */
	renders: boolean;
}

/**
 * The AudioContext constructor this runtime offers, or null where Web Audio is
 * absent. The prefixed name is what older WebKit still ships (see
 * globals.d.ts), and reading both is how a context is opened elsewhere in the
 * plugin.
 */
function audioContextConstructor(): AudioContextConstructor | null {
	const scope = window as Window & {
		AudioContext?: AudioContextConstructor;
	};
	const constructor = scope.AudioContext ?? scope.webkitAudioContext;
	return typeof constructor === 'function' ? constructor : null;
}

/**
 * Whether this runtime can host the live chain at all. Probed on the
 * constructor's prototype rather than by opening a context, because the answer
 * decides whether the control is offered, and that is long before anything is
 * played.
 */
export function isLiveVoiceBoostSupported(): boolean {
	const constructor = audioContextConstructor();
	if (!constructor) {
		return false;
	}
	const prototype = constructor.prototype as Partial<AudioContext>;
	return (
		typeof prototype.createMediaElementSource === 'function' &&
		typeof prototype.createBiquadFilter === 'function' &&
		typeof prototype.createGain === 'function' &&
		typeof prototype.createAnalyser === 'function' &&
		typeof prototype.createDynamicsCompressor === 'function'
	);
}

/**
 * Applies the cleanup chain to playing audio, and takes it away again.
 *
 * The instance is plugin-scoped: it holds the one audio context and every
 * element's graph, so an enable reaches every player on screen rather than the
 * one whose button was pressed.
 */
export class LiveVoiceBoost {
	/** The shared realtime context, opened on the first engage. */
	private context: AudioContext | null = null;
	/**
	 * Every element the chain is offered to, with the graph built for it on
	 * demand. An element that is never engaged holds no graph and so is not
	 * routed through Web Audio at all.
	 */
	private readonly graphs = new Map<
		HTMLMediaElement,
		VoiceBoostGraph | null
	>();
	/** The stages to render, or null before the settings have been read. */
	private stages: VoiceBoostStages | null = null;
	/** Whether the chain is engaged on the elements it has been offered to. */
	private enabled = false;

	/**
	 * Takes the stages to render from the cleanup configuration. Applied to
	 * the elements already engaged, so a change to the cleanup defaults is
	 * heard on the running playback instead of the next one.
	 * @param stages - Stages resolved from the plugin settings
	 */
	setStages(stages: VoiceBoostStages): void {
		if (this.stages && voiceBoostStagesEqual(stages, this.stages)) {
			return;
		}
		this.stages = stages;
		for (const graph of this.graphs.values()) {
			if (graph?.engaged) {
				this.route(graph);
			}
		}
	}

	/** Whether the chain is currently applied to playback. */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Whether the configuration in force has a stage to apply. The offline
	 * pass refuses a run with nothing enabled and says so; the live chain has
	 * no run to refuse, so it reports the same fact and lets the player tell
	 * the listener why their playback did not change.
	 */
	rendersAnyStage(): boolean {
		return this.stages !== null && hasActiveStage(this.stages);
	}

	/**
	 * Offers the chain to an element. Nothing is routed until the chain is
	 * engaged, so a plugin that never engages it leaves playback exactly as it
	 * was.
	 *
	 * The caller offers an element only once its media has loaded, because
	 * routing cannot be undone and media the host refused to serve across
	 * origins routes as silence. `AudioPlayerRegistry` holds that gate, in
	 * `attachVoiceBoostRouting`.
	 * @param audio - Element playing the recording
	 */
	track(audio: HTMLMediaElement): void {
		if (this.graphs.has(audio)) {
			return;
		}
		this.graphs.set(audio, null);
		this.applyTo(audio);
	}

	/**
	 * Drops an element's graph. Called as the element is discarded, which is
	 * the point past which its source node could never be rebuilt.
	 * @param audio - Element being released
	 */
	untrack(audio: HTMLMediaElement): void {
		const graph = this.graphs.get(audio);
		if (graph) {
			this.discard(graph);
		}
		this.graphs.delete(audio);
	}

	/**
	 * Engages or releases the chain on every element it has been offered to.
	 * @param enabled - Whether the chain should render
	 */
	setEnabled(enabled: boolean): void {
		if (enabled && !isLiveVoiceBoostSupported()) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Live voice boost is unavailable here: this runtime has no Web Audio graph to render it with.`,
			);
			return;
		}
		this.enabled = enabled;
		for (const audio of [...this.graphs.keys()]) {
			this.applyTo(audio);
		}
	}

	/**
	 * Releases every graph and closes the context, so nothing outlives the
	 * feature that opened it.
	 */
	dispose(): void {
		for (const graph of this.graphs.values()) {
			if (graph) {
				this.discard(graph);
			}
		}
		this.graphs.clear();
		this.enabled = false;
		const context = this.context;
		this.context = null;
		if (context) {
			void context.close().catch((error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to close the voice-boost audio context.`,
					error,
				);
			});
		}
	}

	/** Brings one element in line with the current enabled state. */
	private applyTo(audio: HTMLMediaElement): void {
		const existing = this.graphs.get(audio);
		if (!this.enabled) {
			if (existing) {
				existing.engaged = false;
				this.route(existing);
			}
			return;
		}
		const graph = existing ?? this.buildGraph(audio);
		if (graph === null) {
			return;
		}
		this.graphs.set(audio, graph);
		graph.engaged = true;
		this.route(graph);
	}

	/**
	 * Builds the element's graph, or returns null where the runtime refuses to
	 * route it. A refusal costs the element nothing: it goes on playing
	 * through itself, and the chain is simply not offered for it.
	 *
	 * Every node the chain is laid out from is built BEFORE the element is
	 * routed, and routing is the last step. It is also the irreversible one:
	 * once an element has a source node its audio exists only inside this
	 * graph, so a refusal that arrived after it would leave the element wired
	 * to a node with nothing behind it, which is silence for the rest of that
	 * element's life. Built in this order, a factory that throws leaves the
	 * element untouched and playing.
	 * @param audio - Element to route into the graph
	 */
	private buildGraph(audio: HTMLMediaElement): VoiceBoostGraph | null {
		const context = this.requireContext();
		if (!context) {
			return null;
		}
		try {
			const highPass = context.createBiquadFilter();
			highPass.type = 'highpass';
			const gate = context.createGain();
			const analyser = context.createAnalyser();
			analyser.fftSize = this.gateWindowSamples(context);
			const compressor = context.createDynamicsCompressor();
			const makeup = context.createGain();
			const source = context.createMediaElementSource(audio);
			const graph: VoiceBoostGraph = {
				element: audio,
				source,
				highPass,
				gate,
				analyser,
				compressor,
				makeup,
				engaged: false,
				gateTimer: 0,
				gateOpen: true,
				gateSamples: new Float32Array(analyser.fftSize),
				playbackEvents: new AbortController(),
			};
			this.watchPlayback(graph);
			return graph;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not route the playing audio into the voice-boost chain.`,
				error,
			);
			return null;
		}
	}

	/**
	 * The analyser window, rounded up to the power of two an FFT requires.
	 * Measured over the same span the offline gate measures, so a threshold
	 * tuned there behaves the same here.
	 * @param context - Context the graph is built in
	 */
	private gateWindowSamples(context: AudioContext): number {
		const wanted = Math.round(
			context.sampleRate * CLEANUP_GATE_WINDOW_SECONDS,
		);
		const rounded = 2 ** Math.ceil(Math.log2(Math.max(1, wanted)));
		return Math.min(
			MAX_GATE_WINDOW_SAMPLES,
			Math.max(MIN_GATE_WINDOW_SAMPLES, rounded),
		);
	}

	/**
	 * Rewires the element's audio for the graph's engaged state and the stages
	 * in force. Engaging, releasing and a stage change are the same operation:
	 * drop every edge and lay the chain out again.
	 *
	 * The stages run in the order the offline pass runs them - gate, then
	 * filter, then leveling - and the gate is where that order matters. The
	 * offline gate decides on the decoded signal, before the filter takes the
	 * rumble out of it, so a threshold tuned there has to decide on the same
	 * signal here. Gating after the filter would let a room's low-frequency
	 * noise hold the gate open offline while the filtered signal fell below
	 * the threshold live, and the quiet passage the control exists for would
	 * be the one it gated away.
	 * @param graph - Graph to lay out
	 */
	private route(graph: VoiceBoostGraph): void {
		this.ensureRunning();
		const context = this.context;
		if (!context) {
			return;
		}
		this.disconnectAll(graph);
		const stages = this.stages;
		let tail: AudioNode = graph.source;
		if (graph.engaged && stages) {
			if (stages.gate.enabled) {
				// The analyser taps the signal on its way into the gate and
				// leaves its own output unconnected, which is what keeps it a
				// meter on the path rather than a second branch of it.
				tail.connect(graph.analyser);
				tail.connect(graph.gate);
				tail = graph.gate;
			}
			if (stages.highPass.enabled) {
				graph.highPass.frequency.value = stages.highPass.hz;
				tail.connect(graph.highPass);
				tail = graph.highPass;
			}
			if (stages.leveling.enabled) {
				const compressor = graph.compressor;
				compressor.threshold.value = CLEANUP_LEVELING_THRESHOLD_DB;
				compressor.knee.value = CLEANUP_LEVELING_KNEE_DB;
				compressor.ratio.value = CLEANUP_LEVELING_RATIO;
				compressor.attack.value = CLEANUP_LEVELING_ATTACK_SECONDS;
				compressor.release.value = CLEANUP_LEVELING_RELEASE_SECONDS;
				graph.makeup.gain.value = dbToGain(stages.leveling.makeupDb);
				tail.connect(compressor);
				compressor.connect(graph.makeup);
				tail = graph.makeup;
			}
		}
		// Always wired, engaged or not: a routed element reaches the speakers
		// only through this graph, so a source left unconnected is a silence.
		tail.connect(context.destination);
		this.syncGateTimer(graph);
	}

	/** Drops every edge out of the graph's nodes, so it can be laid out again. */
	private disconnectAll(graph: VoiceBoostGraph): void {
		graph.source.disconnect();
		graph.highPass.disconnect();
		graph.gate.disconnect();
		graph.analyser.disconnect();
		graph.compressor.disconnect();
		graph.makeup.disconnect();
	}

	/** Stops the graph's gate and discards its nodes with the element. */
	private discard(graph: VoiceBoostGraph): void {
		graph.playbackEvents.abort();
		if (graph.gateTimer !== 0) {
			window.clearInterval(graph.gateTimer);
			graph.gateTimer = 0;
		}
		this.disconnectAll(graph);
	}

	/**
	 * Keeps the gate's loop on the element's playback. The gate measures what
	 * is being played, so an element that is not playing has nothing to
	 * measure: without this the loop would read silence fifty times a second,
	 * for every embed in the note, for as long as the note stayed open.
	 * @param graph - Graph whose element is being watched
	 */
	private watchPlayback(graph: VoiceBoostGraph): void {
		const sync = (): void => {
			this.syncGateTimer(graph);
		};
		// `ended` as well as `pause`, because an element that runs off the end
		// of a recording is not guaranteed to report the pause that put it
		// there.
		const { signal } = graph.playbackEvents;
		graph.element.addEventListener('play', sync, { signal });
		graph.element.addEventListener('pause', sync, { signal });
		graph.element.addEventListener('ended', sync, { signal });
	}

	/**
	 * Runs the gate's level loop while the gate is in the chain and the
	 * element is playing, and stops it otherwise. The gate is the one stage
	 * with no node to set: it is a gain driven by a reading, so it costs a
	 * timer for as long as it runs, and a paused element offers it nothing to
	 * read.
	 *
	 * Starting the loop is also where the gate is opened, which is where the
	 * offline pass starts too. It is the only place that opens it, so a
	 * rewire in the middle of a recording leaves the gate where the last
	 * reading put it instead of snapping it open for one window.
	 * @param graph - Graph whose gate is being wired
	 */
	private syncGateTimer(graph: VoiceBoostGraph): void {
		const wanted =
			graph.engaged &&
			this.stages?.gate.enabled === true &&
			!graph.element.paused;
		if (wanted && graph.gateTimer === 0) {
			graph.gateOpen = true;
			graph.gate.gain.value = 1;
			graph.gateTimer = window.setInterval(() => {
				this.updateGate(graph);
			}, CLEANUP_GATE_WINDOW_SECONDS * 1000);
			return;
		}
		if (!wanted && graph.gateTimer !== 0) {
			window.clearInterval(graph.gateTimer);
			graph.gateTimer = 0;
		}
	}

	/**
	 * One gate decision, taken the way the offline gate takes it: the level
	 * over the last window against the threshold, held by hysteresis so the
	 * gate cannot chatter, and approached with the same time constant as the
	 * sample-by-sample ramp the offline pass walks.
	 * @param graph - Graph whose gate is being driven
	 */
	private updateGate(graph: VoiceBoostGraph): void {
		const context = this.context;
		const stages = this.stages;
		if (!context || !stages) {
			return;
		}
		graph.analyser.getFloatTimeDomainData(graph.gateSamples);
		const rms = computeRms(graph.gateSamples);
		const rmsDb = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
		graph.gateOpen = gateShouldOpen(
			rmsDb,
			stages.gate.thresholdDb,
			CLEANUP_GATE_HYSTERESIS_DB,
			graph.gateOpen,
		);
		const timeConstant =
			(graph.gateOpen
				? CLEANUP_GATE_ATTACK_MS
				: CLEANUP_GATE_RELEASE_MS) / 1000;
		graph.gate.gain.setTargetAtTime(
			graph.gateOpen ? 1 : 0,
			context.currentTime,
			timeConstant,
		);
	}

	/**
	 * The shared context, opened on first use. Null where the runtime has none
	 * or refuses to open one.
	 */
	private requireContext(): AudioContext | null {
		if (this.context) {
			return this.context;
		}
		const constructor = audioContextConstructor();
		if (!constructor) {
			return null;
		}
		try {
			this.context = new constructor();
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not open an audio context for live voice boost.`,
				error,
			);
			return null;
		}
		return this.context;
	}

	/**
	 * Asks the context to run. A context the browser suspended - created
	 * outside a gesture, or taken back by the system when the machine slept -
	 * passes no audio at all, so every engage asks again rather than assuming
	 * the state it was left in.
	 */
	private ensureRunning(): void {
		void this.context?.resume().catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The voice-boost audio context would not start.`,
				error,
			);
		});
	}
}
