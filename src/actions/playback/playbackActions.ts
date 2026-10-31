/**
 * Playback actions surfaced as palette commands and command-line commands,
 * so listening back to a recording is drivable from the keyboard alone, or
 * from a script. Every action delegates to the active playback snapshot
 * published by `AudioPlayerRegistry`, which is the same surface the status-bar
 * controls use, so no transport logic is duplicated here.
 * @module actions/playback/playbackActions
 */

import {
	COMMAND_IDS,
	PLAYER_ICONS,
	PLAYER_PLAYBACK_RATE_PRESETS,
} from '../../constants';
import { steppedPlaybackRate } from '../../player/playbackRate';
import type { PlaybackControlsState } from '../../player/playbackControls';
import type { ActionFamily, PluginCommand } from '../core/PluginAction';

/**
 * An action on the audio that is playing right now. Registered as a
 * palette command gated on the active playback snapshot, so it is absent
 * from the palette (and inert as a hotkey) while nothing plays.
 */
export type PlaybackAction = PluginCommand<PlaybackControlsState>;

/**
 * Needs nothing beyond an active playback, which the family already requires
 * before it offers a command.
 */
const whilePlaying = (): boolean => true;

/** Needs the playback to offer chapter navigation. */
const withChapters = (state: PlaybackControlsState): boolean =>
	state.chaptersEnabled;

/** What one playback action is: its texts, its gate, and what it does. */
interface PlaybackActionSpec {
	readonly commandId: string;
	readonly title: string;
	readonly icon: string;
	readonly isAvailable: (state: PlaybackControlsState) => boolean;
	/** The command-line name. */
	readonly name: string;
	/** The line the command-line help shows. */
	readonly description: string;
	/** What the action does to the playback. */
	readonly act: (state: PlaybackControlsState) => void;
	/** What the command line answers, before the recording's path. */
	readonly done: string;
}

/**
 * Builds a playback action, whose palette command and command-line command
 * do the same thing to the same playback and differ only in what they say.
 * @param spec - The action
 */
function playbackAction(spec: PlaybackActionSpec): PlaybackAction {
	return {
		commandId: spec.commandId,
		title: spec.title,
		icon: spec.icon,
		isAvailable: spec.isAvailable,
		run: spec.act,
		cli: {
			name: spec.name,
			description: spec.description,
			// The only gate beyond something playing is the chapters one.
			unavailable: (state): string =>
				`${state.recordingPath} has no chapters to move between.`,
			execute: (state): string => {
				spec.act(state);
				return `${spec.done} ${state.recordingPath}.`;
			},
		},
	};
}

/**
 * All playback actions in palette order: transport first, then output,
 * speed, and chapter navigation. Adding a marker at the playing position is a
 * position action, since it is the same action as adding one at a point of
 * the player.
 */
export const PLAYBACK_ACTIONS: readonly PlaybackAction[] = [
	playbackAction({
		commandId: COMMAND_IDS.togglePlayback,
		title: 'Play/pause playback',
		icon: PLAYER_ICONS.play,
		isAvailable: whilePlaying,
		name: 'play-pause',
		description: 'Play or pause the recording that is playing in Obsidian.',
		act: (state) => {
			state.onTogglePlay();
		},
		done: 'Toggled play and pause of',
	}),
	playbackAction({
		commandId: COMMAND_IDS.stopPlayback,
		title: 'Stop playback',
		icon: PLAYER_ICONS.stop,
		isAvailable: whilePlaying,
		name: 'stop-playback',
		description: 'Stop the playback in Obsidian.',
		act: (state) => {
			state.onStop();
		},
		done: 'Stopped',
	}),
	playbackAction({
		commandId: COMMAND_IDS.skipPlaybackBack,
		// The step is a setting now, and a command's title is fixed when the
		// plugin loads, so it names the action and leaves the number to the
		// setting rather than promising one it may no longer skip by.
		title: 'Skip playback back',
		icon: PLAYER_ICONS.skipBack,
		isAvailable: whilePlaying,
		name: 'skip-back',
		description: 'Skip the playback back by the configured step.',
		act: (state) => {
			state.onSkip(-state.skipSeconds);
		},
		done: 'Skipped back in',
	}),
	playbackAction({
		commandId: COMMAND_IDS.skipPlaybackForward,
		title: 'Skip playback forward',
		icon: PLAYER_ICONS.skipForward,
		isAvailable: whilePlaying,
		name: 'skip-forward',
		description: 'Skip the playback forward by the configured step.',
		act: (state) => {
			state.onSkip(state.skipSeconds);
		},
		done: 'Skipped forward in',
	}),
	playbackAction({
		commandId: COMMAND_IDS.togglePlaybackMute,
		title: 'Mute/unmute playback',
		icon: PLAYER_ICONS.muted,
		isAvailable: whilePlaying,
		name: 'mute',
		description: 'Mute or unmute the playback.',
		act: (state) => {
			state.onToggleMute();
		},
		done: 'Toggled the sound of',
	}),
	playbackAction({
		commandId: COMMAND_IDS.increasePlaybackSpeed,
		title: 'Increase playback speed',
		icon: PLAYER_ICONS.speed,
		isAvailable: whilePlaying,
		name: 'speed-up',
		description: 'Play faster, at the next speed preset.',
		act: (state) => {
			state.onSetPlaybackRate(
				steppedPlaybackRate(
					state.playbackRate,
					PLAYER_PLAYBACK_RATE_PRESETS,
					1,
				),
			);
		},
		done: 'Sped up',
	}),
	playbackAction({
		commandId: COMMAND_IDS.decreasePlaybackSpeed,
		title: 'Decrease playback speed',
		icon: PLAYER_ICONS.speed,
		isAvailable: whilePlaying,
		name: 'slow-down',
		description: 'Play slower, at the previous speed preset.',
		act: (state) => {
			state.onSetPlaybackRate(
				steppedPlaybackRate(
					state.playbackRate,
					PLAYER_PLAYBACK_RATE_PRESETS,
					-1,
				),
			);
		},
		done: 'Slowed down',
	}),
	playbackAction({
		commandId: COMMAND_IDS.previousChapter,
		title: 'Go to previous chapter',
		icon: PLAYER_ICONS.previousChapter,
		isAvailable: withChapters,
		name: 'previous-chapter',
		description: 'Go to the previous chapter of the playback.',
		act: (state) => {
			state.onPreviousChapter();
		},
		done: 'Went to the previous chapter of',
	}),
	playbackAction({
		commandId: COMMAND_IDS.nextChapter,
		title: 'Go to next chapter',
		icon: PLAYER_ICONS.nextChapter,
		isAvailable: withChapters,
		name: 'next-chapter',
		description: 'Go to the next chapter of the playback.',
		act: (state) => {
			state.onNextChapter();
		},
		done: 'Went to the next chapter of',
	}),
	playbackAction({
		commandId: COMMAND_IDS.toggleChapterLoop,
		title: 'Repeat current chapter',
		icon: PLAYER_ICONS.chapterLoop,
		isAvailable: withChapters,
		name: 'loop-chapter',
		description: 'Repeat the current chapter, or stop repeating it.',
		act: (state) => {
			state.onToggleChapterLoop();
		},
		done: 'Toggled repeating the chapter of',
	}),
];

/**
 * The playback actions as a family: the palette and the command line both act
 * on the playback that is running in the app, and on nothing while nothing
 * plays.
 * @param playback - Reads the live playback, or null when nothing plays
 * @returns The family
 */
export function playbackActionFamily(
	playback: () => PlaybackControlsState | null,
): ActionFamily<PlaybackControlsState> {
	const playing = (): PlaybackControlsState[] => {
		const state = playback();
		return state ? [state] : [];
	};
	return {
		actions: PLAYBACK_ACTIONS,
		activeTargets: playing,
		cliTarget: {
			params: {},
			resolve: () => {
				const targets = playing();
				return targets.length > 0
					? { value: targets }
					: { refusal: 'Nothing is playing in Obsidian.' };
			},
		},
		describe: (state) => state.recordingPath,
	};
}
