/**
 * Shared contract between active audio playback and the status-bar controls.
 * @module player/playbackControls
 */

import type { MarkerKind } from '../markers/markerModel';

/** Existing player operations exposed to the shared status-bar surface. */
export interface PlaybackController {
	/** Whether marker and chapter creation is enabled for this player. */
	canAddMarkers(): boolean;
	/** Whether this player can jump between chapters. */
	canNavigateChapters(): boolean;
	/** Whether playback is currently repeating the chapter it is inside. */
	chapterLoopEnabled(): boolean;
	/**
	 * Title of the chapter the current position falls in, or null when it
	 * falls before the first one (a recording with no chapters included).
	 */
	currentChapterLabel(): string | null;
	/** Turns repeating of the current chapter on or off. */
	toggleChapterLoop(): void;
	/** Seconds a skip moves by, as this player's settings resolved it. */
	skipSeconds(): number;
	/** Starts paused playback or pauses running playback. */
	togglePlay(): void;
	/** Stops playback and resets the player position. */
	stop(): void;
	/** Moves playback by a signed number of seconds. */
	skip(deltaSeconds: number): void;
	/** Toggles muted output. */
	toggleMute(): void;
	/** Applies a volume in the inclusive 0..1 range. */
	setVolume(volume: number): void;
	/** Applies a playback rate multiplier. */
	setPlaybackRate(rate: number): void;
	/** Adds a marker or chapter at the current playback position. */
	addMarker(kind: MarkerKind): void;
	/** Jumps to the chapter before the current position. */
	previousChapter(): void;
	/** Jumps to the chapter after the current position. */
	nextChapter(): void;
}

/**
 * Complete state and command surface for the active status-bar player.
 * Commands stay bound to the playback key represented by this snapshot.
 */
export interface PlaybackControlsState {
	/** Current playback position in seconds. */
	currentTime: number;
	/** Total duration in seconds, or zero while unknown. */
	duration: number;
	/** Whether playback is currently paused. */
	paused: boolean;
	/** Current volume in the inclusive 0..1 range. */
	volume: number;
	/** Whether audio output is muted. */
	muted: boolean;
	/** Current playback rate multiplier. */
	playbackRate: number;
	/** Whether marker and chapter creation is available. */
	markersEnabled: boolean;
	/** Seconds a skip moves by, as the settings resolved it. */
	skipSeconds: number;
	/** Whether chapter navigation is available. */
	chaptersEnabled: boolean;
	/** Whether playback is repeating the chapter it is inside. */
	chapterLoopEnabled: boolean;
	/** Vault-relative path of the recording being played. */
	recordingPath: string;
	/** Title of the chapter the position falls in, or null when there is none. */
	chapterLabel: string | null;
	/** Starts paused playback or pauses running playback. */
	onTogglePlay(): void;
	/** Stops playback, resets it to the start, and dismisses the controls. */
	onStop(): void;
	/** Moves playback by a signed number of seconds. */
	onSkip(deltaSeconds: number): void;
	/** Toggles muted output. */
	onToggleMute(): void;
	/** Applies a volume in the inclusive 0..1 range. */
	onVolumeInput(volume: number): void;
	/** Applies a playback rate multiplier. */
	onSetPlaybackRate(rate: number): void;
	/** Adds a marker or chapter at the current position. */
	onAddMarker(kind: MarkerKind): void;
	/** Jumps to the chapter before the current position. */
	onPreviousChapter(): void;
	/** Jumps to the chapter after the current position. */
	onNextChapter(): void;
	/** Turns repeating of the current chapter on or off. */
	onToggleChapterLoop(): void;
}

/** Receives the active playback snapshot, or null after playback stops. */
export type PlaybackControlsListener = (
	state: PlaybackControlsState | null,
) => void;
