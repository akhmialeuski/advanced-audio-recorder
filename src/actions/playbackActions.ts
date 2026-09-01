/**
 * Playback actions surfaced as palette commands, so listening back to a
 * recording is drivable from the keyboard alone. Every action delegates to
 * the active playback snapshot published by `AudioPlayerRegistry`, which is
 * the same surface the status-bar controls use, so no transport logic is
 * duplicated here.
 * @module actions/playbackActions
 */

import {
	COMMAND_IDS,
	PLAYER_ICONS,
	PLAYER_PLAYBACK_RATE_PRESETS,
} from '../constants';
import { MARKER_KIND } from '../markers/markerModel';
import { steppedPlaybackRate } from '../player/playbackRate';
import type { PlaybackAction } from './PluginAction';

/**
 * Needs nothing beyond an active playback, which the registrar already
 * requires before it offers a command.
 */
const whilePlaying = (): boolean => true;

/**
 * All playback actions in palette order: transport first, then output,
 * speed, chapter navigation, and marker creation.
 */
export const PLAYBACK_ACTIONS: readonly PlaybackAction[] = [
	{
		commandId: COMMAND_IDS.togglePlayback,
		title: 'Play/pause playback',
		icon: PLAYER_ICONS.play,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onTogglePlay();
		},
	},
	{
		commandId: COMMAND_IDS.stopPlayback,
		title: 'Stop playback',
		icon: PLAYER_ICONS.stop,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onStop();
		},
	},
	{
		commandId: COMMAND_IDS.skipPlaybackBack,
		// The step is a setting now, and a command's title is fixed when the
		// plugin loads, so it names the action and leaves the number to the
		// setting rather than promising one it may no longer skip by.
		title: 'Skip playback back',
		icon: PLAYER_ICONS.skipBack,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onSkip(-state.skipSeconds);
		},
	},
	{
		commandId: COMMAND_IDS.skipPlaybackForward,
		title: 'Skip playback forward',
		icon: PLAYER_ICONS.skipForward,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onSkip(state.skipSeconds);
		},
	},
	{
		commandId: COMMAND_IDS.togglePlaybackMute,
		title: 'Mute/unmute playback',
		icon: PLAYER_ICONS.muted,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onToggleMute();
		},
	},
	{
		commandId: COMMAND_IDS.increasePlaybackSpeed,
		title: 'Increase playback speed',
		icon: PLAYER_ICONS.speed,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onSetPlaybackRate(
				steppedPlaybackRate(
					state.playbackRate,
					PLAYER_PLAYBACK_RATE_PRESETS,
					1,
				),
			);
		},
	},
	{
		commandId: COMMAND_IDS.decreasePlaybackSpeed,
		title: 'Decrease playback speed',
		icon: PLAYER_ICONS.speed,
		isAvailable: whilePlaying,
		run: (state): void => {
			state.onSetPlaybackRate(
				steppedPlaybackRate(
					state.playbackRate,
					PLAYER_PLAYBACK_RATE_PRESETS,
					-1,
				),
			);
		},
	},
	{
		commandId: COMMAND_IDS.previousChapter,
		title: 'Go to previous chapter',
		icon: PLAYER_ICONS.previousChapter,
		isAvailable: (state): boolean => state.chaptersEnabled,
		run: (state): void => {
			state.onPreviousChapter();
		},
	},
	{
		commandId: COMMAND_IDS.nextChapter,
		title: 'Go to next chapter',
		icon: PLAYER_ICONS.nextChapter,
		isAvailable: (state): boolean => state.chaptersEnabled,
		run: (state): void => {
			state.onNextChapter();
		},
	},
	{
		commandId: COMMAND_IDS.toggleChapterLoop,
		title: 'Repeat current chapter',
		icon: PLAYER_ICONS.chapterLoop,
		isAvailable: (state): boolean => state.chaptersEnabled,
		run: (state): void => {
			state.onToggleChapterLoop();
		},
	},
	{
		commandId: COMMAND_IDS.addPlaybackBookmark,
		title: 'Add bookmark at current playback position',
		icon: PLAYER_ICONS.addBookmark,
		isAvailable: (state): boolean => state.markersEnabled,
		run: (state): void => {
			state.onAddMarker(MARKER_KIND.bookmark);
		},
	},
	{
		commandId: COMMAND_IDS.addPlaybackChapter,
		title: 'Add chapter at current playback position',
		icon: PLAYER_ICONS.addChapter,
		isAvailable: (state): boolean => state.markersEnabled,
		run: (state): void => {
			state.onAddMarker(MARKER_KIND.chapter);
		},
	},
];
