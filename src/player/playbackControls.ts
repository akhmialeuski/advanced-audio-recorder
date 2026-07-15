/**
 * Shared contract between active audio playback and the status-bar controls.
 * @module player/playbackControls
 */

import type { MarkerKind } from '../markers/markerModel';

/** Existing player operations exposed to the shared status-bar surface. */
export interface PlaybackController {
	/** Whether marker and chapter creation is enabled for this player. */
	canAddMarkers(): boolean;
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
	/** Adds a marker or chapter at the current playback position. */
	addMarker(kind: MarkerKind): void;
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
	/** Whether marker and chapter creation is available. */
	markersEnabled: boolean;
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
	/** Adds a marker or chapter at the current position. */
	onAddMarker(kind: MarkerKind): void;
}

/** Receives the active playback snapshot, or null after playback stops. */
export type PlaybackControlsListener = (
	state: PlaybackControlsState | null,
) => void;
