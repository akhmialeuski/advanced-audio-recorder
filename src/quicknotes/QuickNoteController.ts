/**
 * Quick notes: dictate into the note at the cursor.
 *
 * One press opens the microphone, the next one stops it, and the text lands at
 * the cursor of the note the dictation was started in, rewritten first by the
 * quick note profile when one is selected. Everything between is the plugin's
 * existing machinery: the capture is the in-memory recorder the settings test
 * uses, the transcription and the rewrite are {@link TranscriptionService}'s
 * dictation run, and the text goes in through the note inserter. This module
 * only sequences them and owns the one state the ribbon button shows.
 *
 * The audio is never written anywhere. It lives in the recorder's chunks and
 * then in one buffer handed to the run, and both are dropped the moment the
 * run is over, whichever way it ends.
 * @module quicknotes/QuickNoteController
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { RecordingStatus } from '../types';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { quickNoteRefusal } from '../settings/settingsAttention';
import { CaptureStart, type MemoryRecorder } from '../recording/MemoryRecorder';
import {
	captureInsertionContext,
	insertTextAtCursor,
} from '../recording/NoteInserter';
import { DebugLogger } from '../utils/DebugLogger';
import {
	CancellationSource,
	type CancellationToken,
} from '../utils/cancellation';
import type {
	DictateOptions,
	DictationAudio,
	DictationResult,
} from '../transcription/TranscriptionService';
import { TranscriptionCancelledError } from '../transcription/TranscriptionService';
import type { RunCostSink } from '../transcription/SessionCostTracker';
import type { InsertionContext } from '../types';

/** What the quick note controller needs from the rest of the plugin. */
export interface QuickNoteDeps {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	/** The capture the dictation is recorded with. */
	readonly recorder: MemoryRecorder;
	/** Transcribes the dictation, and rewrites it when a profile says so. */
	readonly dictate: (
		audio: DictationAudio,
		options: DictateOptions,
	) => Promise<DictationResult>;
	/** Where the transcription's cost is recorded. */
	readonly costs: RunCostSink;
	/**
	 * Whether a recording session holds the microphone. A dictation is not
	 * started over one: the two would capture the same speech twice, and the
	 * quick note would land in the note the recording's link goes to.
	 */
	readonly recordingActive: () => boolean;
	/** Told every time the state the ribbon button shows changes. */
	readonly onStatusChange: (status: RecordingStatus) => void;
}

/**
 * Sequences one quick note at a time: idle, recording, then saving while the
 * dictation is transcribed and inserted.
 */
export class QuickNoteController {
	private status: RecordingStatus = RecordingStatus.Idle;
	/** Settles once the microphone open started by the last press is done. */
	private starting: Promise<boolean> = Promise.resolve(false);
	/** The note the dictation was started in. */
	private insertionContext: InsertionContext | null = null;
	/** Cancels the run in flight when the plugin unloads. */
	private run: CancellationSource | null = null;

	constructor(private readonly deps: QuickNoteDeps) {}

	/** The state the ribbon button shows. */
	getStatus(): RecordingStatus {
		return this.status;
	}

	/**
	 * Starts a dictation, or stops the running one and inserts its text. A
	 * press while the last dictation is still being transcribed only says so.
	 */
	async toggle(): Promise<void> {
		switch (this.status) {
			case RecordingStatus.Idle:
				this.starting = this.start();
				await this.starting;
				return;
			case RecordingStatus.Recording:
				await this.finish();
				return;
			default:
				new Notice('The last quick note is still being transcribed.');
		}
	}

	/**
	 * Discards whatever is under way: closes the microphone and cancels the
	 * run in flight. Called when the plugin unloads and when quick notes are
	 * switched off, neither of which has anywhere left to put the text.
	 */
	cancel(): void {
		this.deps.recorder.cancel();
		this.run?.cancel();
		this.run = null;
		this.setStatus(RecordingStatus.Idle);
	}

	/**
	 * Opens the microphone, after checking that the dictation could be
	 * transcribed at all, so a user is never left speaking into a note that
	 * refuses the text afterwards.
	 * @returns Whether the capture is running
	 */
	private async start(): Promise<boolean> {
		const settings = this.deps.getSettings();
		const refusal = quickNoteRefusal(settings);
		if (refusal !== null) {
			new Notice(refusal);
			return false;
		}
		if (this.deps.recordingActive()) {
			new Notice('Stop the recording before dictating a quick note.');
			return false;
		}
		this.insertionContext = captureInsertionContext(
			this.deps.app,
			true,
			new DebugLogger(settings),
		);
		// Shown before the microphone opens, so a second press during the
		// permission prompt stops this dictation instead of starting another.
		this.setStatus(RecordingStatus.Recording);
		try {
			const started = await this.deps.recorder.start(settings);
			if (started === CaptureStart.Unsupported) {
				new Notice(
					`Format "${settings.recordingFormat}" cannot be recorded here. Pick another output format.`,
				);
			}
			if (started !== CaptureStart.Started) {
				this.setStatus(RecordingStatus.Idle);
				return false;
			}
			return true;
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Quick note could not open the microphone:`,
				error,
			);
			new Notice(
				`Quick note could not open the microphone: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.setStatus(RecordingStatus.Idle);
			return false;
		}
	}

	/**
	 * Stops the capture, transcribes it, and inserts the text. The audio is
	 * dropped once this returns, whichever way it ends.
	 */
	private async finish(): Promise<void> {
		// A press that lands while the microphone is still being opened stops
		// the capture that open produces rather than one that is not there.
		if (!(await this.starting)) {
			return;
		}
		this.setStatus(RecordingStatus.Saving);
		const run = new CancellationSource();
		this.run = run;
		const progress = new Notice('Transcribing quick note...', 0);
		try {
			const clip = await this.deps.recorder.stop();
			if (clip.kind !== 'recorded') {
				if (clip.kind === 'empty') {
					new Notice('The quick note recorded no audio.');
				}
				return;
			}
			const result = await this.deps.dictate(
				{
					bytes: await clip.blob.arrayBuffer(),
					extension: clip.recorderFormat,
				},
				{
					token: run.token,
					onProgress: (_fraction, label) => {
						progress.setMessage(`Quick note: ${label}`);
					},
				},
			);
			this.deps.costs.recordRun(
				result.cost,
				result.settings,
				result.sentSeconds,
			);
			await this.deliver(result.text, run.token);
		} catch (error) {
			if (!(error instanceof TranscriptionCancelledError)) {
				console.error(`${PLUGIN_LOG_PREFIX} Quick note failed:`, error);
				new Notice(
					`Quick note failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			progress.hide();
			if (this.run === run) {
				this.run = null;
				this.setStatus(RecordingStatus.Idle);
			}
		}
	}

	/**
	 * Puts the text where the dictation was asked for, or on the clipboard
	 * when no note is open to take it, so a paid dictation is never lost for
	 * want of a cursor.
	 * @param text - The text to insert
	 * @param token - Cancellation for the run; a cancelled run inserts nothing
	 */
	private async deliver(
		text: string,
		token: CancellationToken,
	): Promise<void> {
		if (token.isCancelled()) {
			return;
		}
		if (text === '') {
			new Notice('Nothing was recognized in the quick note.');
			return;
		}
		if (insertTextAtCursor(this.deps.app, text, this.insertionContext)) {
			return;
		}
		await navigator.clipboard.writeText(text);
		new Notice(
			'No note is open to take the quick note, so its text was copied to the clipboard.',
		);
	}

	/**
	 * Records the state and tells the ribbon.
	 * @param status - The new state
	 */
	private setStatus(status: RecordingStatus): void {
		this.status = status;
		this.deps.onStatusChange(status);
	}
}
