/**
 * Plays short excerpts of one recording for the speaker rename dialog: the
 * stretch where a speaker first talks, so "who is Speaker 2?" is answered by
 * listening rather than by remembering what the dialog is covering.
 *
 * Deliberately its own audio element rather than the shared one the registry
 * hands out: a preview must not hijack (or be hijacked by) the embedded player
 * of the same recording in the note behind the dialog, and it must not appear
 * in the status-bar transport, which offers seek, skip, and markers - none of
 * which belong to a two-button preview. The transport commands themselves are
 * the shared ones from {@link player/playbackCommands}, so seeking and stopping
 * behave exactly as everywhere else.
 *
 * One excerpt plays at a time: starting another stops the previous, which is
 * what makes a column of play buttons behave like a set of radio buttons.
 * @module player/SpeakerPreviewPlayer
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { SpeakerPreviewRange } from '../speakers/speakerPreview';
import { resetPlayback, seekAudio } from './playbackCommands';

/**
 * Plays bounded excerpts of a single audio file, one at a time.
 */
export class SpeakerPreviewPlayer {
	/** Created on the first play, so a dialog nobody previews loads nothing. */
	private audio: HTMLAudioElement | null = null;
	/** Id of the excerpt currently playing, or null when stopped. */
	private currentId: string | null = null;
	/** Offset the current excerpt stops at. */
	private endSeconds = 0;
	/**
	 * Start offset waiting for the element's metadata, or null when none is
	 * pending. A freshly built element reports readyState 0, so the very first
	 * press always lands here; holding the offset in a field (rather than in a
	 * deferred seek) is what makes it cancellable, so a stop pressed while the
	 * file is still loading cannot be overtaken by its own start.
	 */
	private pendingStart: number | null = null;
	private disposed = false;

	/** Stops the excerpt once playback reaches its end. */
	private readonly handleTimeUpdate = (): void => {
		if (this.currentId !== null && this.audio) {
			if (this.audio.currentTime >= this.endSeconds) {
				this.stop();
			}
		}
	};

	/** The file ended before the excerpt did (a truncated recording). */
	private readonly handleEnded = (): void => {
		this.stop();
	};

	/** The element can seek now; start whatever press is still waiting. */
	private readonly handleLoadedMetadata = (): void => {
		this.startPending();
	};

	/**
	 * @param resolveSrc - Resolves the media URL of the recording, called once
	 *   on the first play so the dialog never resolves a resource it does not
	 *   use
	 * @param onChange - Notified with the id now playing (null when stopped),
	 *   so the dialog can flip the pressed button between play and stop
	 */
	constructor(
		private readonly resolveSrc: () => string,
		private readonly onChange: (playingId: string | null) => void,
	) {}

	/** Id of the excerpt currently playing, or null when nothing is. */
	get playingId(): string | null {
		return this.currentId;
	}

	/**
	 * Plays an excerpt, or stops it when that same excerpt is already playing -
	 * so one button per row is all the column needs. Starting a different
	 * excerpt stops the current one first.
	 * @param id - Caller's identity for the excerpt (the speaker label)
	 * @param range - The stretch to play
	 */
	toggle(id: string, range: SpeakerPreviewRange): void {
		if (this.disposed) {
			return;
		}
		if (this.currentId === id) {
			this.stop();
			return;
		}
		const audio = this.ensureAudio();
		this.currentId = id;
		this.endSeconds = range.end;
		this.pendingStart = range.start;
		// Metadata already loaded (any press after the first): start at once.
		// Otherwise handleLoadedMetadata picks the offset up, and a stop in the
		// meantime simply clears it.
		if (audio.readyState >= 1) {
			this.startPending();
		}
		this.onChange(this.currentId);
	}

	/** Stops the current excerpt. A no-op when nothing is playing. */
	stop(): void {
		if (this.currentId === null) {
			return;
		}
		// Cleared before the reset so the position change it emits is not read
		// as the excerpt reaching its end and stopping a second time. Dropping
		// the pending offset is what stops a press that is still waiting for
		// metadata from starting audio after the user already stopped it.
		this.currentId = null;
		this.pendingStart = null;
		if (this.audio) {
			resetPlayback(this.audio);
		}
		this.onChange(null);
	}

	/**
	 * Stops playback and releases the media element. Idempotent, and after it
	 * the player stays inert - a click racing the dialog's close can never
	 * start audio that would outlive the dialog.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.stop();
		this.disposed = true;
		const audio = this.audio;
		this.audio = null;
		if (!audio) {
			return;
		}
		audio.removeEventListener('timeupdate', this.handleTimeUpdate);
		audio.removeEventListener('ended', this.handleEnded);
		audio.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
	}

	/**
	 * Seeks to the pending start and plays. A no-op once the press it belongs
	 * to was stopped or replaced, so a late-arriving metadata event can never
	 * resurrect it.
	 */
	private startPending(): void {
		const audio = this.audio;
		const start = this.pendingStart;
		if (!audio || start === null || this.currentId === null) {
			return;
		}
		this.pendingStart = null;
		seekAudio(audio, start, {
			autoplay: true,
			onError: (error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Speaker preview could not start:`,
					error,
				);
				// The excerpt is not playing, so the button must not claim it is.
				this.stop();
			},
		});
	}

	/** Returns the media element, creating and wiring it on first use. */
	private ensureAudio(): HTMLAudioElement {
		const existing = this.audio;
		if (existing) {
			return existing;
		}
		const audio = new Audio();
		audio.preload = 'metadata';
		audio.src = this.resolveSrc();
		audio.addEventListener('timeupdate', this.handleTimeUpdate);
		audio.addEventListener('ended', this.handleEnded);
		// One persistent listener rather than one per press, so rapid presses
		// cannot pile up seeks that all fire when the file finally loads.
		audio.addEventListener('loadedmetadata', this.handleLoadedMetadata);
		this.audio = audio;
		return audio;
	}
}
