/**
 * Tests for the playback actions as the command line runs them: each acts on
 * the playback running in the app, as its palette command does, and says what
 * it acted on; with nothing playing there is nothing to act on.
 * @module tests/unit/playbackActionsCli.test
 */

import {
	PLAYBACK_ACTIONS,
	playbackActionFamily,
} from 'src/actions/playbackActions';
import { COMMAND_IDS } from 'src/constants';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { makePlaybackState } from '../helpers/playbackHarness';

/** The action of the given command id. */
function action(commandId: string): (typeof PLAYBACK_ACTIONS)[number] {
	const found = PLAYBACK_ACTIONS.find(
		(entry) => entry.commandId === commandId,
	);
	if (!found) {
		throw new Error(`No playback action ${commandId}`);
	}
	return found;
}

describe('a playback action on the command line', () => {
	it.each([
		{
			id: COMMAND_IDS.togglePlayback,
			name: 'play-pause',
			call: 'onTogglePlay',
			said: 'Toggled play and pause of',
		},
		{
			id: COMMAND_IDS.stopPlayback,
			name: 'stop-playback',
			call: 'onStop',
			said: 'Stopped',
		},
		{
			id: COMMAND_IDS.skipPlaybackBack,
			name: 'skip-back',
			call: 'onSkip',
			said: 'Skipped back in',
		},
		{
			id: COMMAND_IDS.skipPlaybackForward,
			name: 'skip-forward',
			call: 'onSkip',
			said: 'Skipped forward in',
		},
		{
			id: COMMAND_IDS.togglePlaybackMute,
			name: 'mute',
			call: 'onToggleMute',
			said: 'Toggled the sound of',
		},
		{
			id: COMMAND_IDS.increasePlaybackSpeed,
			name: 'speed-up',
			call: 'onSetPlaybackRate',
			said: 'Sped up',
		},
		{
			id: COMMAND_IDS.decreasePlaybackSpeed,
			name: 'slow-down',
			call: 'onSetPlaybackRate',
			said: 'Slowed down',
		},
		{
			id: COMMAND_IDS.previousChapter,
			name: 'previous-chapter',
			call: 'onPreviousChapter',
			said: 'Went to the previous chapter of',
		},
		{
			id: COMMAND_IDS.nextChapter,
			name: 'next-chapter',
			call: 'onNextChapter',
			said: 'Went to the next chapter of',
		},
		{
			id: COMMAND_IDS.toggleChapterLoop,
			name: 'loop-chapter',
			call: 'onToggleChapterLoop',
			said: 'Toggled repeating the chapter of',
		},
	] satisfies {
		id: string;
		name: string;
		call: keyof PlaybackControlsState;
		said: string;
	}[])(
		'$name does what its palette command does',
		({ id, name, call, said }) => {
			const state = makePlaybackState();

			const answer = action(id).cli.execute(state, {});

			expect(action(id).cli.name).toBe(name);
			expect(state[call]).toHaveBeenCalledTimes(1);
			expect(answer).toBe(`${said} Recordings/lecture.webm.`);
		},
	);

	it('says the playback has no chapters where the chapter commands are hidden', () => {
		expect(
			action(COMMAND_IDS.nextChapter).cli.unavailable?.(
				makePlaybackState({ chaptersEnabled: false }),
			),
		).toBe('Recordings/lecture.webm has no chapters to move between.');
	});
});

describe('the playback the commands act on', () => {
	it('is the one running, on every surface', async () => {
		const state = makePlaybackState();
		const family = playbackActionFamily(() => state);

		expect(family.activeTargets()).toEqual([state]);
		await expect(
			Promise.resolve(family.cliTarget.resolve({})),
		).resolves.toEqual({ value: [state] });
		expect(family.describe(state)).toBe('Recordings/lecture.webm');
	});

	it('is none while nothing plays', async () => {
		const family = playbackActionFamily(() => null);

		expect(family.activeTargets()).toEqual([]);
		await expect(
			Promise.resolve(family.cliTarget.resolve({})),
		).resolves.toEqual({ refusal: 'Nothing is playing in Obsidian.' });
	});
});
