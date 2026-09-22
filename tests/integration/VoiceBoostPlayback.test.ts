/**
 * The live voice boost driven the way a listener drives it: the real player
 * over the real registry, the real control row, and the shared audio element
 * playback actually runs through - with the audio context recorded rather than
 * mocked away.
 *
 * The chain is a reconnection of a graph, so what has to hold is what a
 * reconnection can get wrong. A media element can be routed into a graph once
 * in its life, so the graph is built on the first press and rewired by every
 * one after it. A routed element reaches the speakers only through the graph,
 * so switching the chain off has to leave the sound on. And the graph holds
 * the element, so closing the note and tearing the plugin down both have to
 * take it with them.
 * @jest-environment jsdom
 */

import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';
import { clickControl, control, maybeControl } from '../helpers/dom';
import {
	audioPathOf,
	installAudioGraphMock,
	nodeOfKind,
	type AudioGraphContextDouble,
	type InstalledMock,
} from '../helpers/mediaMocks';
import {
	installSharedAudio,
	makeMarkerStore,
	makePlayerApp,
	makePlayerContainer,
	makePlayerFile,
	makeRefusingDecoder,
} from '../helpers/playbackHarness';
import { SHARED_AUDIO_GRACE_MS } from 'src/constants';
import { resolveVoiceBoostStages } from 'src/cleanup/audioDsp';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import { WaveformPeakCache } from 'src/player/WaveformData';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';

const app = makePlayerApp();

const decoder = makeRefusingDecoder();

const PLAYER: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
	skipSeconds: 10,
};

/**
 * Settings whose cleanup stages the live chain renders, with the high-pass
 * alone so a chain is one filter long unless a case says otherwise.
 * @param overrides - Cleanup values a case wants to differ from
 * @returns Settings carrying the fields the chain resolves
 */
function cleanupSettings(
	overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	return partial<AudioRecorderSettings>({
		cleanupHighPassEnabled: true,
		cleanupHighPassHz: 120,
		cleanupNoiseGateEnabled: false,
		cleanupNoiseGateThresholdDb: -50,
		cleanupLevelingEnabled: false,
		cleanupLevelingMakeupDb: 6,
		...overrides,
	});
}

let shared: ReturnType<typeof installSharedAudio>;
let graph: InstalledMock<AudioGraphContextDouble>;

beforeEach(() => {
	shared = installSharedAudio();
	graph = installAudioGraphMock();
});

afterEach(() => {
	graph.restore();
	shared.restore();
});

/** The context the plugin opened. */
function context(): AudioGraphContextDouble {
	return at(graph.instances, 0, 'the audio context the plugin opened');
}

/** The kinds along the shared element's path, for a readable assertion. */
function pathKinds(): string[] {
	return (audioPathOf(context(), shared.audio) ?? []).map(
		(node) => node.kind,
	);
}

/**
 * Mounts a real player of the recording into a fresh container. Through
 * load() rather than onload(), so the component records itself as loaded and
 * a later unload() runs what the player registered.
 * @param registry - The registry the player binds its shared element through
 * @param startSeconds - The embed's #t= offset, absent by default
 * @returns The container the player rendered into, and the player itself
 */
function mountPlayer(
	registry: AudioPlayerRegistry,
	startSeconds: number | null = null,
): { container: HTMLElement; player: AudioPlayer } {
	const container = makePlayerContainer();
	const player = new AudioPlayer(
		container,
		app,
		makePlayerFile(),
		PLAYER,
		registry,
		new WaveformPeakCache(),
		decoder,
		makeMarkerStore(),
		{ startSeconds, sourcePath: 'note.md', immediate: true },
	);
	player.load();
	return { container, player };
}

/**
 * A registry prepared with the stages a player's chain would render, and a
 * player bound to it.
 * @param settings - Cleanup configuration the chain resolves
 * @returns The registry, the container the player rendered into, and the player
 */
function createSut(settings: AudioRecorderSettings = cleanupSettings()): {
	registry: AudioPlayerRegistry;
	container: HTMLElement;
	player: AudioPlayer;
} {
	const registry = new AudioPlayerRegistry();
	registry.applyVoiceBoostStages(resolveVoiceBoostStages(settings));
	return { registry, ...mountPlayer(registry) };
}

describe('the live voice boost on a playing embed', () => {
	it('builds the chain over the running playback when the control is pressed', () => {
		const { container } = createSut();
		void shared.audio.play();

		clickControl(container, 'Voice boost');

		expect(pathKinds()).toEqual(['source', 'biquad', 'destination']);
		expect(control(container, 'Voice boost')).toBeActiveControl();
	});

	// The element is the one playing, not a second one built for the chain:
	// a rebuilt element is a restart, and the point of the feature is that
	// nothing has to be restarted to hear a quiet passage.
	it('routes the playing element itself, without stopping it', () => {
		const { container } = createSut();
		void shared.audio.play();

		clickControl(container, 'Voice boost');

		expect(context().sources.map((entry) => entry.element)).toEqual([
			shared.audio,
		]);
		expect(shared.audio.paused).toBe(false);
	});

	it('returns the audio to the untouched path when the control is pressed again', () => {
		const { container } = createSut();
		clickControl(container, 'Voice boost');

		clickControl(container, 'Voice boost');

		expect(pathKinds()).toEqual(['source', 'destination']);
		expect(control(container, 'Voice boost')).not.toBeActiveControl();
	});

	it('renders the chain once, however often it is switched', () => {
		const { container } = createSut();

		clickControl(container, 'Voice boost');
		clickControl(container, 'Voice boost');
		clickControl(container, 'Voice boost');

		expect(context().sources).toHaveLength(1);
		expect(pathKinds()).toHaveLength(3);
	});

	it('renders the stages the cleanup configuration holds', () => {
		const { container } = createSut(
			cleanupSettings({
				cleanupHighPassEnabled: true,
				cleanupHighPassHz: 200,
				cleanupLevelingEnabled: true,
				cleanupLevelingMakeupDb: 9,
			}),
		);

		clickControl(container, 'Voice boost');

		expect(
			nodeOfKind(context(), 'biquad').parameters['frequency']?.value,
		).toBe(200);
		expect(pathKinds()).toEqual([
			'source',
			'biquad',
			'compressor',
			'gain',
			'destination',
		]);
	});

	// A second player of the recording, and a player opened later in the
	// session, both play through the chain that is already running.
	it('shows the chain on a player rendered after it was engaged', () => {
		const { registry, container } = createSut();
		clickControl(container, 'Voice boost');

		const second = mountPlayer(registry).container;

		expect(control(second, 'Voice boost')).toBeActiveControl();
	});

	it('shows the chain on every open player when one of them engages it', () => {
		const { registry, container } = createSut();
		const other = mountPlayer(registry, 30).container;

		clickControl(container, 'Voice boost');

		expect(control(other, 'Voice boost')).toBeActiveControl();
	});

	// The graph holds the element it was built on, so it is released where the
	// element is: closing the note is the last moment its nodes can be freed.
	it('releases the graph when the note closes', () => {
		jest.useFakeTimers();
		try {
			const { container, player } = createSut();
			clickControl(container, 'Voice boost');

			player.unload();
			jest.advanceTimersByTime(SHARED_AUDIO_GRACE_MS);

			expect(audioPathOf(context(), shared.audio)).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});

	it('closes the audio context when the plugin is torn down', () => {
		const { registry, container } = createSut();
		clickControl(container, 'Voice boost');

		registry.clear();

		expect(context().closed).toBe(true);
	});

	it('leaves the playback untouched when the chain is never engaged', () => {
		createSut();

		expect(graph.instances).toHaveLength(0);
		expect(shared.audio.paused).toBe(true);
	});
});

describe('where the runtime cannot host the chain', () => {
	// Offering a control that could not process anything is worse than
	// offering none: the audio chain is what the control is for.
	it('leaves the control out of the row', () => {
		graph.restore();
		const { container } = createSut();

		expect(maybeControl(container, 'Voice boost')).toBeNull();
	});

	it('reports the chain as engaged for nothing, rather than failing', () => {
		graph.restore();
		const registry = new AudioPlayerRegistry();

		expect(registry.toggleVoiceBoost()).toEqual({
			available: false,
			enabled: false,
		});
	});
});
