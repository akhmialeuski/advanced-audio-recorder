/**
 * Tests for the system media-session announcement: what the lock screen is
 * told about a playing recording, which controls it is offered, and that the
 * announcement is taken down rather than left answering a plugin that has
 * unloaded. Every action is checked to reach the published playback snapshot,
 * which is what keeps the transport logic in one place.
 * @jest-environment jsdom
 */

import { MediaSessionBridge } from 'src/player/MediaSessionBridge';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type {
	PlaybackControlsListener,
	PlaybackControlsState,
} from 'src/player/playbackControls';
import {
	installMediaSession,
	withoutMediaSession,
	type MediaSessionDouble,
} from '../helpers/mediaSession';
import { makePlaybackState } from '../helpers/playbackHarness';

/** Teardown for whatever a case installed, drained after each. */
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

interface Sut {
	media: MediaSessionDouble;
	bridge: MediaSessionBridge;
	publish: (state: PlaybackControlsState | null) => void;
	unsubscribed: () => boolean;
}

/**
 * A bridge over a registry double whose published snapshots the test drives.
 * @param options - Actions the platform refuses, if any
 * @returns The bridge, the session it talks to, and a publisher
 */
function createSut(
	options: { unsupported?: readonly MediaSessionAction[] } = {},
): Sut {
	const media = installMediaSession(options);
	let listener: PlaybackControlsListener = () => undefined;
	let unsubscribed = false;
	const registry = {
		subscribePlayback: (next: PlaybackControlsListener) => {
			listener = next;
			return () => {
				unsubscribed = true;
			};
		},
	} as unknown as AudioPlayerRegistry;
	const bridge = MediaSessionBridge.create(registry);
	if (!bridge) {
		throw new Error('The installed media session was not picked up');
	}
	// Every case ends the same way, and a case that forgot would leak a
	// session onto the next one.
	cleanups.push(() => {});
	return {
		media,
		bridge,
		publish: (state) => {
			listener(state);
		},
		unsubscribed: () => unsubscribed,
	};
}

describe('a platform with no media session', () => {
	it('builds no bridge at all', () => {
		const restore = withoutMediaSession();

		expect(
			MediaSessionBridge.create({
				subscribePlayback: () => () => undefined,
			} as unknown as AudioPlayerRegistry),
		).toBeNull();

		restore();
	});
});

describe('announcing a playing recording', () => {
	it('names the recording, the plugin, and the chapter', () => {
		const { media, publish } = createSut();

		publish(
			makePlaybackState({
				recordingPath: 'Recordings/2026/lecture.webm',
				chapterLabel: 'Second half',
			}),
		);

		expect(media.metadata()).toMatchObject({
			title: 'lecture',
			artist: 'Advanced Audio Recorder',
			album: 'Second half',
		});
	});

	it('names a recording that has no chapter, with no album text', () => {
		const { media, publish } = createSut();

		publish(makePlaybackState({ recordingPath: 'note.mp3' }));

		expect(media.metadata()).toMatchObject({ title: 'note', album: '' });
	});

	it('rebuilds the metadata only when the text changes', () => {
		const { media, publish } = createSut();
		publish(makePlaybackState({ currentTime: 10 }));
		const first = media.metadata();

		publish(makePlaybackState({ currentTime: 11 }));

		// A snapshot arrives on every timeupdate, and the same two strings
		// must not allocate metadata four times a second
		expect(media.metadata()).toBe(first);

		publish(makePlaybackState({ chapterLabel: 'Second half' }));
		expect(media.metadata()).not.toBe(first);
	});

	it.each([
		{ state: 'playing', paused: false, announced: 'playing' },
		{ state: 'paused', paused: true, announced: 'paused' },
	])('announces the recording as $state', ({ paused, announced }) => {
		const { media, publish } = createSut();

		publish(makePlaybackState({ paused }));

		expect(media.playbackState()).toBe(announced);
	});

	it('tells the system where playback stands, so a scrubber can be drawn', () => {
		const { media, publish } = createSut();

		publish(
			makePlaybackState({
				currentTime: 65,
				duration: 222,
				playbackRate: 1.5,
			}),
		);

		expect(media.positions).toEqual([
			{ duration: 222, position: 65, playbackRate: 1.5 },
		]);
	});

	it.each([
		{ case: 'the duration is not known yet', currentTime: 5, duration: 0 },
		{
			case: 'the position has run past the duration',
			currentTime: 400,
			duration: 222,
		},
	])('reports no position while $case', ({ currentTime, duration }) => {
		const { media, publish } = createSut();

		publish(makePlaybackState({ currentTime, duration }));

		// The platform rejects both outright, and a thrown position update
		// would take the announcement down with it
		expect(media.positions).toEqual([]);
	});
});

describe('the controls the system is offered', () => {
	it.each([
		{ action: 'play' as const, command: 'onTogglePlay' as const },
		{ action: 'pause' as const, command: 'onTogglePlay' as const },
		{ action: 'stop' as const, command: 'onStop' as const },
	])('drives $command from the $action control', ({ action, command }) => {
		const { media, publish } = createSut();
		const state = makePlaybackState();
		publish(state);

		media.fire(action);

		expect(state[command]).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ action: 'seekbackward' as const, expected: -10 },
		{ action: 'seekforward' as const, expected: 10 },
	])('skips by the configured step from $action', ({ action, expected }) => {
		const { media, publish } = createSut();
		const state = makePlaybackState({ skipSeconds: 10 });
		publish(state);

		media.fire(action);

		expect(state.onSkip).toHaveBeenCalledWith(expected);
	});

	it('honours a seek offset the system asks for', () => {
		const { media, publish } = createSut();
		const state = makePlaybackState({ skipSeconds: 10 });
		publish(state);

		media.fire('seekforward', { action: 'seekforward', seekOffset: 45 });

		expect(state.onSkip).toHaveBeenCalledWith(45);
	});

	it('turns a scrubber drop into a move from where playback stands', () => {
		const { media, publish } = createSut();
		const state = makePlaybackState({ currentTime: 65 });
		publish(state);

		media.fire('seekto', { action: 'seekto', seekTime: 200 });

		expect(state.onSkip).toHaveBeenCalledWith(135);
	});

	it('ignores a scrubber drop that names no position', () => {
		const { media, publish } = createSut();
		const state = makePlaybackState();
		publish(state);

		media.fire('seekto', { action: 'seekto' });

		expect(state.onSkip).not.toHaveBeenCalled();
	});

	it('offers the chapter controls only where there are chapters', () => {
		const { media, publish } = createSut();

		publish(makePlaybackState({ chaptersEnabled: false }));
		expect(media.registered()).not.toContain('nexttrack');

		publish(makePlaybackState({ chaptersEnabled: true }));
		expect(media.registered()).toEqual(
			expect.arrayContaining(['previoustrack', 'nexttrack']),
		);

		publish(makePlaybackState({ chaptersEnabled: false }));
		expect(media.registered()).not.toContain('previoustrack');
	});

	it.each([
		{
			action: 'previoustrack' as const,
			command: 'onPreviousChapter' as const,
		},
		{ action: 'nexttrack' as const, command: 'onNextChapter' as const },
	])('jumps chapters from the $action control', ({ action, command }) => {
		const { media, publish } = createSut();
		const state = makePlaybackState({ chaptersEnabled: true });
		publish(state);

		media.fire(action);

		expect(state[command]).toHaveBeenCalledTimes(1);
	});

	it('registers the rest when the platform refuses one control', () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The registration that survived is the assertion.
		});
		const { media, publish } = createSut({ unsupported: ['stop'] });
		const state = makePlaybackState();
		publish(state);

		media.fire('play');

		expect(media.registered()).not.toContain('stop');
		expect(state.onTogglePlay).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('does nothing with a control fired after playback stopped', () => {
		const { media, publish } = createSut();
		const state = makePlaybackState();
		publish(state);

		publish(null);
		media.fire('play');

		expect(state.onTogglePlay).not.toHaveBeenCalled();
	});
});

describe('taking the announcement down', () => {
	it('clears what the system shows once playback stops', () => {
		const { media, publish } = createSut();
		publish(makePlaybackState({ chaptersEnabled: true }));

		publish(null);

		expect(media.metadata()).toBeNull();
		expect(media.playbackState()).toBe('none');
		expect(media.registered()).not.toContain('nexttrack');
	});

	it('stops listening and clears the session when the plugin unloads', () => {
		const { media, publish, bridge, unsubscribed } = createSut();
		publish(makePlaybackState());

		bridge.dispose();

		expect(unsubscribed()).toBe(true);
		expect(media.metadata()).toBeNull();
		expect(media.playbackState()).toBe('none');
	});

	// Clearing the metadata is not the same as giving the controls back. The
	// transport handlers are bound once at construction, so an unload that
	// left them registered kept the bridge and its last snapshot alive for the
	// life of the window, and a press of the play key went on reaching a
	// plugin that had gone instead of whatever else would have answered it.
	it('gives every control back to the system when the plugin unloads', () => {
		const { media, publish, bridge } = createSut();
		publish(makePlaybackState({ chaptersEnabled: true }));
		expect(media.registered()).not.toHaveLength(0);

		bridge.dispose();

		expect(media.registered()).toEqual([]);
	});

	it('announces again after a stop, since the metadata was cleared', () => {
		const { media, publish } = createSut();
		publish(makePlaybackState({ recordingPath: 'first.webm' }));
		publish(null);

		publish(makePlaybackState({ recordingPath: 'first.webm' }));

		expect(media.metadata()).toMatchObject({ title: 'first' });
	});
});
