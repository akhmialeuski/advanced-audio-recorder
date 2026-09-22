/**
 * Unit tests for the live voice-boost chain.
 *
 * What the module has to get right is not which node is wired where - that is
 * a reconnection - but the two things a reconnection can get wrong. A media
 * element can be routed into an audio graph once in its life, so the graph has
 * to survive every toggle and release rather than be rebuilt. And the element
 * reaches the speakers only through the graph once it is routed, so both
 * states have to end at the output.
 *
 * The nodes themselves are the platform's, so the double records what was
 * asked for and the assertions are about the shape of the wiring.
 * @module tests/unit/LiveVoiceBoost.test
 */

import {
	DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
	DEFAULT_CLEANUP_HIGHPASS_HZ,
	DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
	CLEANUP_GATE_ATTACK_MS,
	CLEANUP_GATE_HYSTERESIS_DB,
	CLEANUP_GATE_RELEASE_MS,
	CLEANUP_GATE_WINDOW_SECONDS,
	CLEANUP_LEVELING_KNEE_DB,
	CLEANUP_LEVELING_RATIO,
	CLEANUP_LEVELING_THRESHOLD_DB,
} from 'src/constants';
import type { VoiceBoostStages } from 'src/cleanup/audioDsp';
import {
	isLiveVoiceBoostSupported,
	LiveVoiceBoost,
} from 'src/player/LiveVoiceBoost';
import { at, defined } from '../helpers/assertions';
import { globals, silenceConsole } from '../helpers/doubles';
import {
	audioPathOf,
	installAudioGraphMock,
	nodeOfKind,
	type AudioGraphContextDouble,
	type AudioNodeDouble,
	type AudioParamDouble,
	type InstalledMock,
} from '../helpers/mediaMocks';

/** Stages with nothing enabled, so a case names only what it switches on. */
function noStages(): VoiceBoostStages {
	return {
		highPass: { enabled: false, hz: DEFAULT_CLEANUP_HIGHPASS_HZ },
		gate: {
			enabled: false,
			thresholdDb: DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
		},
		leveling: {
			enabled: false,
			makeupDb: DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
		},
	};
}

/** Stages with every stage enabled, which is the whole chain. */
function allStages(): VoiceBoostStages {
	return {
		highPass: { enabled: true, hz: 120 },
		gate: { enabled: true, thresholdDb: -40 },
		leveling: { enabled: true, makeupDb: 9 },
	};
}

/** The only stage with a level loop of its own. */
function gateOnly(): VoiceBoostStages {
	const stages = noStages();
	stages.gate.enabled = true;
	return stages;
}

describe('the live voice boost', () => {
	let graph: InstalledMock<AudioGraphContextDouble>;

	beforeEach(() => {
		graph = installAudioGraphMock();
	});

	afterEach(() => {
		graph.restore();
	});

	/**
	 * The context the plugin opened.
	 * @returns The one context, or a failure naming that there is none
	 */
	function context(): AudioGraphContextDouble {
		return at(graph.instances, 0, 'the audio context the plugin opened');
	}

	/** One node of the recorded graph, by kind and creation order. */
	function nodeOf(kind: string, index = 0): AudioNodeDouble {
		return nodeOfKind(context(), kind, index);
	}

	/** The element's path through the graph, or null while it is not routed. */
	function audioPath(audio: HTMLMediaElement): AudioNodeDouble[] | null {
		return audioPathOf(context(), audio);
	}

	/** The kinds along the element's path, for a readable assertion. */
	function pathKinds(audio: HTMLMediaElement): string[] {
		return (audioPath(audio) ?? []).map((node) => node.kind);
	}

	/**
	 * An element with the chain offered to it.
	 * @returns The booster and the element
	 */
	function createSut(): {
		boost: LiveVoiceBoost;
		audio: HTMLMediaElement;
	} {
		const boost = new LiveVoiceBoost();
		const audio = document.createElement('audio');
		boost.track(audio);
		return { boost, audio };
	}

	describe('whether the runtime can host it', () => {
		it('reports the chain as available where the context offers every node it needs', () => {
			expect(isLiveVoiceBoostSupported()).toBe(true);
		});

		it('reports it as unavailable where the runtime has no audio context', () => {
			graph.restore();

			expect(isLiveVoiceBoostSupported()).toBe(false);
		});

		// The probe reads the constructor's prototype, which belongs to the
		// throwaway class this install created: removing a member there cannot
		// reach another case.
		it.each([
			{
				name: 'media element routing',
				member: 'createMediaElementSource',
			},
			{ name: 'the high-pass filter', member: 'createBiquadFilter' },
			{ name: 'a gain stage', member: 'createGain' },
			{ name: 'the level meter', member: 'createAnalyser' },
			{ name: 'the compressor', member: 'createDynamicsCompressor' },
		])('reports it as unavailable where $name is missing', ({ member }) => {
			const scope = globals()['AudioContext'] as {
				prototype: Record<string, unknown>;
			};
			delete scope.prototype[member];

			expect(isLiveVoiceBoostSupported()).toBe(false);
		});
	});

	describe('engaging the chain on an element', () => {
		// Nothing is routed until the control is pressed, so a plugin whose
		// chain is never engaged leaves the playback exactly as it was.
		it('routes nothing until the chain is engaged', () => {
			const { boost } = createSut();
			boost.setStages(allStages());

			expect(graph.instances).toHaveLength(0);
			expect(boost.isEnabled()).toBe(false);
		});

		it('passes the audio through the stages once the chain is engaged', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());

			boost.setEnabled(true);

			// The order the offline pass runs them in: the gate decides on the
			// signal the filter has not touched yet
			expect(pathKinds(audio)).toEqual([
				'source',
				'gain',
				'biquad',
				'compressor',
				'gain',
				'destination',
			]);
		});

		// A media element can be taken into a graph once in its life: the
		// double refuses a second routing, so a rebuild here would throw.
		it('creates the element source once, however often the chain is toggled', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());

			boost.setEnabled(true);
			boost.setEnabled(false);
			boost.setEnabled(true);

			expect(context().sources).toHaveLength(1);
			expect(audioPath(audio)).toHaveLength(6);
		});

		it('returns the element to the untouched path when the chain is released', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);

			boost.setEnabled(false);

			expect(pathKinds(audio)).toEqual(['source', 'destination']);
			expect(boost.isEnabled()).toBe(false);
		});

		// A routed element reaches the speakers only through the graph, so the
		// disconnection a release could be is the one thing it may never be.
		it('keeps the element audible while it is engaged', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());

			boost.setEnabled(true);

			expect(audioPath(audio)?.at(-1)).toBe(context().destination);
		});

		it('keeps the element audible after the chain is released', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);

			boost.setEnabled(false);

			expect(audioPath(audio)?.at(-1)).toBe(context().destination);
		});

		// A factory that threw after the element had been routed would leave it
		// wired to a node with nothing behind it, and a routed element reaches
		// the speakers only through the graph: silence for the rest of its life.
		// The source is created last so that a refused build costs it nothing.
		it('creates the element source only once its nodes all exist', () => {
			const { boost } = createSut();
			boost.setStages(allStages());

			boost.setEnabled(true);

			expect(context().nodes.at(-1)).toBe(nodeOf('source'));
		});

		it('opens one context for two elements, and routes each of them', () => {
			const { boost, audio } = createSut();
			const second = document.createElement('audio');
			boost.track(second);
			boost.setStages(allStages());

			boost.setEnabled(true);

			expect(graph.instances).toHaveLength(1);
			expect(context().sources).toHaveLength(2);
			expect(pathKinds(audio)).toHaveLength(6);
			expect(pathKinds(second)).toHaveLength(6);
		});

		it('asks the context to run, which a suspended one does not', () => {
			const { boost } = createSut();
			boost.setStages(allStages());

			boost.setEnabled(true);

			expect(context().resumes).toBe(1);
		});

		it('refuses to engage where the runtime has no audio context', () => {
			const warn = silenceConsole('warn');
			const { boost } = createSut();
			boost.setStages(allStages());
			graph.restore();

			boost.setEnabled(true);

			expect(boost.isEnabled()).toBe(false);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('Live voice boost is unavailable'),
			);
		});
	});

	describe('the stages it renders', () => {
		it('renders only the stages the configuration enables', () => {
			const stages = noStages();
			stages.highPass.enabled = true;
			const { boost, audio } = createSut();
			boost.setStages(stages);

			boost.setEnabled(true);

			expect(pathKinds(audio)).toEqual([
				'source',
				'biquad',
				'destination',
			]);
		});

		// Until the settings have been read there is nothing to render, and
		// the element is wired straight through rather than left unrouted.
		it('falls back to the untouched path when no stages are configured', () => {
			const { boost, audio } = createSut();

			boost.setEnabled(true);

			expect(pathKinds(audio)).toEqual(['source', 'destination']);
		});

		it('carries the high-pass cutoff onto the filter', () => {
			const stages = noStages();
			stages.highPass.enabled = true;
			stages.highPass.hz = 140;
			const { boost } = createSut();
			boost.setStages(stages);

			boost.setEnabled(true);

			expect(nodeOf('biquad').parameters['frequency']?.value).toBe(140);
			// Left at the Q a BiquadFilterNode starts from, which is what the
			// offline pass builds: a resonance here would colour the sound the
			// file path leaves alone
			expect(nodeOf('biquad').parameters['Q']?.value).toBe(1);
		});

		// The two renderers have to produce the same sound, so the live chain
		// takes the fixed curve from the shared constants rather than its own.
		it('carries the speech compressor curve onto the leveling stage', () => {
			const stages = noStages();
			stages.leveling.enabled = true;
			const { boost } = createSut();
			boost.setStages(stages);

			boost.setEnabled(true);

			const compressor = nodeOf('compressor').parameters;
			expect(compressor['threshold']?.value).toBe(
				CLEANUP_LEVELING_THRESHOLD_DB,
			);
			expect(compressor['knee']?.value).toBe(CLEANUP_LEVELING_KNEE_DB);
			expect(compressor['ratio']?.value).toBe(CLEANUP_LEVELING_RATIO);
		});

		it('carries the makeup gain onto the stage after the compressor', () => {
			const stages = noStages();
			stages.leveling.enabled = true;
			stages.leveling.makeupDb = 12;
			const { boost } = createSut();
			boost.setStages(stages);

			boost.setEnabled(true);

			// 12 dB is a little under a factor of four
			expect(nodeOf('gain', 1).parameters['gain']?.value).toBeCloseTo(
				3.981,
				3,
			);
		});

		it('rewires an engaged chain when the stages change', () => {
			const { boost, audio } = createSut();
			boost.setStages(noStages());
			boost.setEnabled(true);

			boost.setStages(allStages());

			expect(pathKinds(audio)).toHaveLength(6);
			expect(nodeOf('biquad').parameters['frequency']?.value).toBe(120);
		});

		// A settings save that moved no cleanup value reaches every open player,
		// and re-routing on each of them would be a click in the playback of a
		// recording nobody asked to change.
		it('leaves an engaged chain alone when the stages are unchanged', () => {
			const { boost } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);
			const source = nodeOf('source');
			const rewires = source.disconnects;

			boost.setStages(allStages());

			expect(rewires).toBeGreaterThan(0);
			expect(source.disconnects).toBe(rewires);
		});
	});

	describe('the noise gate', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		/**
		 * A chain engaged over a fresh element with the gate in it.
		 * @param thresholdDb - Gate threshold in dBFS
		 * @returns The booster, the element, and the parameter the loop drives
		 */
		function engagedGate(thresholdDb = -40): {
			boost: LiveVoiceBoost;
			audio: HTMLMediaElement;
			gain: AudioParamDouble;
		} {
			const { boost, audio } = createSut();
			const stages = gateOnly();
			stages.gate.thresholdDb = thresholdDb;
			boost.setStages(stages);
			boost.setEnabled(true);
			return {
				boost,
				audio,
				gain: defined(nodeOf('gain', 0).parameters['gain']),
			};
		}

		/**
		 * Runs one window of the loop at a level the analyser reports.
		 * @param amplitude - Peak amplitude the meter reads
		 */
		function readLevel(amplitude: number): void {
			context().analyserAmplitude = amplitude;
			jest.advanceTimersByTime(CLEANUP_GATE_WINDOW_SECONDS * 1000);
		}

		it('starts the gate open, as the offline pass does', () => {
			const { boost } = createSut();
			boost.setStages(gateOnly());

			boost.setEnabled(true);

			expect(nodeOf('gain', 0).parameters['gain']?.value).toBe(1);
		});

		it('taps the signal into the meter on its way to the gate', () => {
			const { boost } = createSut();
			boost.setStages(gateOnly());
			boost.setEnabled(true);

			const analyser = nodeOf('analyser');
			// Out of the node feeding the gate, and a meter rather than a path:
			// nothing audible leaves it
			expect(nodeOf('source').outputs).toContain(analyser);
			expect(analyser.outputs).toHaveLength(0);
		});

		// The gate is a gain driven by a reading rather than a node that
		// gates on its own, so it costs a loop for as long as it is engaged.
		it('runs its level loop only while the gate is in the chain', () => {
			const { boost } = createSut();
			boost.setStages(gateOnly());
			boost.setEnabled(true);
			const gate = nodeOf('gain', 0);

			jest.advanceTimersByTime(CLEANUP_GATE_WINDOW_SECONDS * 1000 * 3);
			const whileEngaged = gate.parameters['gain']?.scheduled.length;
			boost.setEnabled(false);
			jest.advanceTimersByTime(CLEANUP_GATE_WINDOW_SECONDS * 1000 * 3);

			expect(whileEngaged).toBeGreaterThan(0);
			expect(gate.parameters['gain']?.scheduled).toHaveLength(
				whileEngaged ?? 0,
			);
		});

		it('closes the gate once the level falls below the threshold', () => {
			const { gain } = engagedGate();

			readLevel(0.001);

			expect(gain.scheduled.at(-1)?.value).toBe(0);
		});

		it('opens the gate while the level is above the threshold', () => {
			const { gain } = engagedGate();

			readLevel(0.5);

			expect(gain.scheduled.at(-1)?.value).toBe(1);
		});

		// The hysteresis is what stops the gate chattering around the
		// threshold, and it is the offline pass's margin, not a second one.
		it('holds the gate open within the hysteresis band', () => {
			const thresholdDb = -40;
			const { gain } = engagedGate(thresholdDb);
			readLevel(0.5);

			// Half the margin below the threshold: still open
			readLevel(
				10 ** ((thresholdDb - CLEANUP_GATE_HYSTERESIS_DB / 2) / 20),
			);

			expect(gain.scheduled.at(-1)?.value).toBe(1);
		});

		// An interval left behind would keep reading an element that has been
		// let go, and would hold the timer for the life of the page.
		it('stops its level loop with the graph it was driving', () => {
			const { boost, audio, gain } = engagedGate();
			jest.advanceTimersByTime(CLEANUP_GATE_WINDOW_SECONDS * 1000);
			const whileEngaged = gain.scheduled.length;

			boost.untrack(audio);
			jest.advanceTimersByTime(CLEANUP_GATE_WINDOW_SECONDS * 1000 * 3);

			expect(whileEngaged).toBeGreaterThan(0);
			expect(gain.scheduled).toHaveLength(whileEngaged);
		});

		it('ramps with the offline attack and release time constants', () => {
			const { gain } = engagedGate();

			readLevel(0.001);

			expect(gain.scheduled.at(-1)?.timeConstant).toBe(
				CLEANUP_GATE_RELEASE_MS / 1000,
			);

			readLevel(0.5);

			expect(gain.scheduled.at(-1)?.timeConstant).toBe(
				CLEANUP_GATE_ATTACK_MS / 1000,
			);
		});
	});

	describe('releasing', () => {
		it('drops the graph with the element it was built on', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);

			boost.untrack(audio);

			expect(nodeOf('source').disconnects).toBeGreaterThan(0);
			expect(audioPath(audio)).toBeNull();
		});

		it('routes nothing for an element it no longer tracks', () => {
			const { boost, audio } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);
			boost.untrack(audio);

			boost.setEnabled(false);
			boost.setEnabled(true);

			expect(audioPath(audio)).toBeNull();
		});

		it('releases every element it was routing', () => {
			const { boost, audio } = createSut();
			const second = document.createElement('audio');
			boost.track(second);
			boost.setStages(allStages());
			boost.setEnabled(true);

			boost.dispose();

			expect(nodeOf('source', 0).disconnects).toBeGreaterThan(0);
			expect(nodeOf('source', 1).disconnects).toBeGreaterThan(0);
			expect(audioPath(audio)).toBeNull();
			expect(audioPath(second)).toBeNull();
		});

		// A context left open holds an audio thread the plugin no longer needs,
		// and a page may open only a handful of them.
		it('closes the audio context when the chain is disposed', () => {
			const { boost } = createSut();
			boost.setStages(allStages());
			boost.setEnabled(true);

			boost.dispose();

			expect(context().closed).toBe(true);
			expect(boost.isEnabled()).toBe(false);
		});
	});
});
