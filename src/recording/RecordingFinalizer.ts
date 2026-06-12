/**
 * Finalization stage of the recording pipeline: turns flushed segment
 * files and remaining buffers into final audio files, mixes
 * multi-track sessions, cleans up temporary artifacts, inserts note
 * links, and reports deduplicated save progress.
 * @module recording/RecordingFinalizer
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type {
	InsertionContext,
	RecordingSessionConfig,
	RecordingTarget,
	SaveProgress,
} from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import { PLUGIN_LOG_PREFIX, FORMAT_WAV } from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import {
	assembleWavFromPcmSegments,
	createWavHeader,
	WAV_HEADER_SIZE,
} from './WavEncoder';
import { isOfflineEncodingSupported } from './AudioEncoder';
import {
	resolveUniquePath,
	saveAudioFile,
	removeTemporaryArtifacts,
	cleanupIntermediateFiles,
} from './RecordingFileManager';
import {
	isOfflineOnlyFormat,
	convertBlobToWav,
	convertBlobToFormat,
	mergeAudioTracks,
} from './AudioFormatConverter';
import { buildMimeType } from './AudioCapabilityDetector';
import { canStreamMix, mixPcmTracksToWav } from './StreamingMixer';
import { buildPartFileName } from './AudioSplitter';
import { insertFileLinks } from './NoteInserter';
import type { TrackWriteQueue } from './TrackWriteQueue';
import { SessionJournal } from './SessionJournal';

/**
 * Finalizes recording sessions into vault audio files.
 */
export class RecordingFinalizer {
	/** Session configuration set by beginSession. */
	private session: RecordingSessionConfig | null = null;
	/** Last save-progress percent reported to the status bar. */
	private lastProgressPercent = -1;
	/** Last save-progress description reported to the status bar. */
	private lastProgressDescription = '';

	/**
	 * Creates a new RecordingFinalizer.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings (live reference)
	 * @param writeQueue - Write queue used to flush remaining buffers
	 * @param debugLogger - Debug logger
	 * @param onProgress - Receives deduplicated save-progress updates
	 * @param journal - Crash-recovery journal tracking segment files
	 */
	constructor(
		private readonly app: App,
		private settings: AudioRecorderSettings,
		private readonly writeQueue: TrackWriteQueue,
		private readonly debugLogger: DebugLogger,
		private readonly onProgress: (progress: SaveProgress) => void,
		private readonly journal: SessionJournal = new SessionJournal(
			null,
			app,
		),
	) {}

	/**
	 * Updates the live settings reference.
	 * @param settings - New settings
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.settings = settings;
	}

	/**
	 * Starts a new recording session: stores the session snapshot and
	 * resets the progress deduplication.
	 * @param session - Session configuration snapshot
	 */
	beginSession(session: RecordingSessionConfig): void {
		this.session = session;
		this.lastProgressPercent = -1;
		this.lastProgressDescription = '';
	}

	/**
	 * Returns the active session configuration.
	 * @throws Error when called outside a recording session
	 */
	private requireSession(): RecordingSessionConfig {
		if (!this.session) {
			throw new Error('No active recording session');
		}
		return this.session;
	}

	/**
	 * Reports save progress, skipping updates whose whole percent and
	 * description did not change. Encoders may emit progress per audio
	 * frame (hundreds of thousands of calls for a long recording), and
	 * every accepted update touches the DOM.
	 * @param percent - Progress percentage (0-100)
	 * @param description - Progress phase description
	 */
	reportProgress(percent: number, description: string): void {
		const wholePercent = Math.round(percent);
		if (
			wholePercent === this.lastProgressPercent &&
			description === this.lastProgressDescription
		) {
			return;
		}
		this.lastProgressPercent = wholePercent;
		this.lastProgressDescription = description;
		this.onProgress({ percent: wholePercent, description });
	}

	/**
	 * Finalizes a stopped recording session: flushes remaining buffers,
	 * produces the final file(s) — per track or mixed — and inserts the
	 * note links.
	 * @param targets - Recording targets of the session
	 * @param timestamp - Session timestamp for the merged file name
	 * @param insertionContext - Where to insert the file links
	 */
	async saveRecording(
		targets: RecordingTarget[],
		timestamp: string | null,
		insertionContext: InsertionContext | null,
	): Promise<void> {
		const session = this.requireSession();
		const effectiveTimestamp =
			timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');
		const fileLinks: string[] = [];

		this.reportProgress(20, 'Flushing buffers...');

		if (this.settings.outputMode === 'single') {
			if (targets.length === 1) {
				const target = targets[0];
				const paths = await this.finalizeTrackFiles(target);
				fileLinks.push(...target.partPaths, ...paths);
			} else {
				if (!session.isWavPcm) {
					await Promise.all(
						targets.map((target) =>
							this.writeQueue.flushChunkBuffer(target),
						),
					);
				}
				if (session.isWavPcm) {
					await Promise.all(
						targets.map((target) =>
							this.writeQueue.flushPcmBuffer(target),
						),
					);
				}
				this.reportProgress(40, 'Mixing tracks...');
				const targetFormat = isOfflineEncodingSupported(
					this.settings.recordingFormat,
				)
					? this.settings.recordingFormat
					: FORMAT_WAV;
				if (
					targetFormat === FORMAT_WAV &&
					this.settings.recordingFormat !== FORMAT_WAV
				) {
					this.debugLogger.log(
						'Multi-track single output falls back to WAV (encoding unavailable)',
						{
							requestedFormat: this.settings.recordingFormat,
						},
					);
					new Notice(
						'Merged multi-track output saved as .wav (encoding unavailable for this format).',
					);
				}
				// PCM sessions mixing to WAV stream from disk in bounded
				// memory; everything else (compressed outputs, rate
				// mismatches, MediaRecorder sessions) uses the Web Audio
				// mix, which is also the platform's resampler
				let mergedAudio: Blob | null = null;
				if (session.isWavPcm && targetFormat === FORMAT_WAV) {
					mergedAudio = await this.tryStreamMixToWav(targets);
				}
				mergedAudio ??= await mergeAudioTracks(
					targets,
					this.settings,
					session.isWavPcm,
					(target) => this.buildPcmTrackWavBlob(target),
					(target) => this.buildTrackBlob(target),
					(percent, description) => {
						this.reportProgress(percent, description);
					},
				);
				this.reportProgress(60, 'Writing file...');
				const fileName = `${this.settings.filePrefix}-multitrack-${effectiveTimestamp}.${targetFormat}`;
				const filePath = await saveAudioFile(
					mergedAudio,
					fileName,
					this.app,
					this.settings,
				);
				if (filePath) {
					this.reportProgress(80, 'Cleaning up...');
					const intermediatePaths = targets.flatMap(
						(target) => target.segmentPaths,
					);
					const failedCleanupPaths = await cleanupIntermediateFiles(
						targets,
						this.app,
					);
					this.journal.removeSegments(
						intermediatePaths.filter(
							(path) => !failedCleanupPaths.includes(path),
						),
					);
					if (failedCleanupPaths.length > 0) {
						// Keep the merged file: it already contains all
						// captured audio, while segments removed by the
						// partial cleanup exist nowhere else. Rolling it back
						// would lose their audio permanently. Failed segments
						// stay journaled for the next launch.
						console.error(
							`${PLUGIN_LOG_PREFIX} Temporary segment files could not be removed:`,
							failedCleanupPaths,
						);
						new Notice(
							`Recording saved, but temporary files could not be removed: ${failedCleanupPaths.join(', ')}`,
						);
					}
					fileLinks.push(filePath);
				} else {
					// An empty merged blob writes no final file; the
					// segment files are the only copy of the captured
					// audio, so they are kept and reported instead of
					// being silently orphaned in the vault
					const keptPaths = targets.flatMap(
						(target) => target.segmentPaths,
					);
					if (keptPaths.length > 0) {
						console.error(
							`${PLUGIN_LOG_PREFIX} Merged output was empty; temporary segment files were kept:`,
							keptPaths,
						);
						new Notice(
							`Merged recording was empty. Temporary track files were kept: ${keptPaths.join(', ')}`,
						);
					}
				}
			}
		} else {
			for (const target of targets) {
				const paths = await this.finalizeTrackFiles(target);
				fileLinks.push(...target.partPaths, ...paths);
			}
		}

		if (fileLinks.length > 0) {
			insertFileLinks(fileLinks, insertionContext, this.app);
			new Notice(`Saved ${String(fileLinks.length)} audio file(s)`);
		} else {
			new Notice('No audio data recorded');
		}
	}

	/**
	 * Builds the final track file name, appending the part suffix when
	 * the session was auto-split (the residual after the last rotation
	 * becomes the next part number). Uses the base name snapshotted at
	 * session start so the residual matches its sibling part files even
	 * when the file prefix setting changed mid-recording.
	 * @param target - Recording target
	 * @param extension - File extension without the dot
	 */
	private buildTrackFileName(
		target: RecordingTarget,
		extension: string,
	): string {
		const session = this.requireSession();
		if (target.partIndex > 0) {
			return buildPartFileName(
				target.fileBaseName,
				session.partSuffix,
				target.partIndex + 1,
				extension,
			);
		}
		return `${target.fileBaseName}.${extension}`;
	}

	/**
	 * Finalizes one track into its final file(s) at session stop.
	 * @param target - Recording target to finalize
	 * @returns Paths of the created files
	 */
	private async finalizeTrackFiles(
		target: RecordingTarget,
	): Promise<string[]> {
		const session = this.requireSession();
		const fileLinks: string[] = [];
		if (session.isMobile) {
			await this.writeQueue.flushChunkBuffer(target);
			fileLinks.push(...target.segmentPaths);
			return fileLinks;
		}

		if (session.isWavPcm) {
			this.reportProgress(20, 'Flushing buffers...');
			await this.writeQueue.flushPcmBuffer(target);
			if (target.segmentPaths.length === 0) {
				return fileLinks;
			}
			this.reportProgress(40, 'Assembling audio...');
			const fileName = this.buildTrackFileName(target, FORMAT_WAV);
			const filePath = await resolveUniquePath(
				fileName,
				this.app,
				this.settings,
			);
			this.reportProgress(60, 'Writing file...');
			await this.assembleWavFile(target, filePath);
			fileLinks.push(filePath);
			return fileLinks;
		}

		const fileName = this.buildTrackFileName(target, session.outputFormat);
		const filePath = await this.finalizeMediaTrackToFile(
			target,
			fileName,
			true,
		);
		if (filePath) {
			fileLinks.push(filePath);
		}
		return fileLinks;
	}

	/**
	 * Finalizes buffered MediaRecorder data of one track into a final
	 * audio file: flushes the chunk buffer to segment files and hands
	 * them to finalizeSegmentsToFile. Used at stop; part rotation
	 * finalizes detached snapshots directly instead.
	 * @param target - Recording target to finalize
	 * @param fileName - Final file name
	 * @param reportProgress - Whether to emit save-progress status updates
	 * @returns Final file path, or null when no audio data is buffered
	 */
	private async finalizeMediaTrackToFile(
		target: RecordingTarget,
		fileName: string,
		reportProgress: boolean = false,
	): Promise<string | null> {
		await this.writeQueue.flushChunkBuffer(target);
		const filePath = await this.finalizeSegmentsToFile(
			target.segmentPaths,
			fileName,
			reportProgress,
		);
		if (filePath) {
			target.segmentPaths = [];
			target.segmentIndex = 0;
		}
		return filePath;
	}

	/**
	 * Transcodes and writes a list of raw segment files into one final
	 * audio file in the session output format, then removes the
	 * temporary segments (segments that cannot be removed are reported
	 * and left on disk; the final file is always kept). Operates on an
	 * explicit segment list so part rotation can finalize a detached
	 * snapshot while the next part is recording.
	 * @param segmentPaths - Segment files in capture order
	 * @param fileName - Final file name
	 * @param reportProgress - Whether to emit save-progress status
	 * updates (must stay false during rotation: the Saving status would
	 * tear down the status bar recording controls)
	 * @returns Final file path, or null when the segments hold no data
	 */
	async finalizeSegmentsToFile(
		segmentPaths: string[],
		fileName: string,
		reportProgress: boolean = false,
	): Promise<string | null> {
		const session = this.requireSession();
		if (segmentPaths.length === 0) {
			return null;
		}
		const segmentBuffers = await Promise.all(
			segmentPaths.map((path) => this.app.vault.adapter.readBinary(path)),
		);
		const blob = new Blob(segmentBuffers, {
			type: buildMimeType(session.recorderFormat),
		});
		if (blob.size === 0) {
			return null;
		}

		const outputFormat = session.outputFormat;
		const filePath = await resolveUniquePath(
			fileName,
			this.app,
			this.settings,
		);

		if (outputFormat === FORMAT_WAV) {
			if (reportProgress) {
				this.reportProgress(40, 'Assembling audio...');
			}
			const wavBlob = await convertBlobToWav(blob);
			if (reportProgress) {
				this.reportProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await wavBlob.arrayBuffer(),
			);
		} else if (isOfflineOnlyFormat(outputFormat, session.recorderFormat)) {
			// Offline-only format: decode intermediate blob, re-encode to target
			if (reportProgress) {
				this.reportProgress(40, 'Encoding audio...');
			}
			const outputBlob = await convertBlobToFormat(
				blob,
				outputFormat,
				session.bitrate,
				(percent) => {
					if (reportProgress) {
						this.reportProgress(
							40 + Math.round(percent * 0.2),
							'Encoding audio...',
						);
					}
				},
				// The intermediate blob was recorded at the session
				// bitrate, so a codec-matching remux preserves it
				{ allowRemux: true },
			);
			if (reportProgress) {
				this.reportProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await outputBlob.arrayBuffer(),
			);
		} else {
			if (reportProgress) {
				this.reportProgress(60, 'Writing file...');
			}
			await this.app.vault.createBinary(
				filePath,
				await blob.arrayBuffer(),
			);
		}

		if (reportProgress) {
			this.reportProgress(80, 'Cleaning up...');
		}
		const failedCleanupPaths = await removeTemporaryArtifacts(
			segmentPaths,
			'Failed to remove segment file after finalization',
			this.app,
		);
		this.journal.removeSegments(
			segmentPaths.filter((path) => !failedCleanupPaths.includes(path)),
		);
		if (failedCleanupPaths.length > 0) {
			// Keep the final file: it already contains all captured audio,
			// while segments that were removed exist nowhere else. Rolling
			// it back would lose their audio permanently and leave part
			// bookkeeping pointing at missing segment files.
			console.error(
				`${PLUGIN_LOG_PREFIX} Temporary segment files could not be removed:`,
				failedCleanupPaths,
			);
			new Notice(
				`Recording saved, but temporary files could not be removed: ${failedCleanupPaths.join(', ')}`,
			);
		}

		return filePath;
	}

	/**
	 * Assembles the flushed PCM segments of a target into a WAV file
	 * and removes the consumed segments.
	 * @param target - Recording target whose segments to assemble
	 * @param filePath - Path of the WAV file to create
	 */
	async assembleWavFile(
		target: RecordingTarget,
		filePath: string,
	): Promise<void> {
		const wavBuffer = await this.buildWavBufferFromSegments(target);

		await this.app.vault.createBinary(filePath, wavBuffer);

		const failedPaths = await removeTemporaryArtifacts(
			target.segmentPaths,
			'Failed to remove PCM segment file after WAV assembly',
			this.app,
		);
		this.journal.removeSegments(
			target.segmentPaths.filter((path) => !failedPaths.includes(path)),
		);
		if (failedPaths.length > 0) {
			// Keep the assembled file: it already contains all captured
			// audio, while segments that were removed exist nowhere else.
			// Rolling it back would lose their audio permanently and leave
			// part bookkeeping pointing at missing segment files.
			console.error(
				`${PLUGIN_LOG_PREFIX} Temporary segment files could not be removed:`,
				failedPaths,
			);
			new Notice(
				`Recording saved, but temporary files could not be removed: ${failedPaths.join(', ')}`,
			);
		}
	}

	/**
	 * Attempts the bounded-memory streaming mix of flushed PCM tracks
	 * into a WAV blob. Returns null when the tracks cannot be
	 * stream-mixed (rate mismatch, no data, adapter without stat) or
	 * the mix fails — the caller then uses the Web Audio path.
	 * @param targets - Recording targets with flushed PCM segments
	 * @returns Mixed WAV blob, or null to fall back
	 */
	private async tryStreamMixToWav(
		targets: RecordingTarget[],
	): Promise<Blob | null> {
		const tracks = targets
			.filter((target) => target.segmentPaths.length > 0)
			.map((target) => ({
				segmentPaths: target.segmentPaths,
				channels: target.pcmChannels,
				sampleRate: target.pcmSampleRate,
			}));
		if (!canStreamMix(tracks)) {
			return null;
		}
		try {
			const wavBuffer = await mixPcmTracksToWav(
				tracks,
				this.app,
				(percent) => {
					this.reportProgress(
						40 + Math.round(percent * 0.2),
						'Mixing tracks...',
					);
				},
			);
			return new Blob([wavBuffer], { type: 'audio/wav' });
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Streaming mix failed, falling back to the Web Audio mix:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Assembles the WAV file buffer for a target's PCM segments. When
	 * the adapter can report file sizes, the final buffer is allocated
	 * once and the segments stream into it sequentially — peak memory
	 * is the final file plus one segment, instead of two full copies of
	 * the recording. Falls back to read-all-then-assemble otherwise.
	 * @param target - Recording target with flushed PCM segments
	 * @returns Complete WAV file bytes
	 */
	private async buildWavBufferFromSegments(
		target: RecordingTarget,
	): Promise<ArrayBuffer> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.stat === 'function') {
			const stats = await Promise.all(
				target.segmentPaths.map((path) => adapter.stat(path)),
			);
			if (stats.every((stat) => stat != null)) {
				const totalPcmSize = stats.reduce(
					(sum, stat) => sum + (stat?.size ?? 0),
					0,
				);
				const wavBuffer = new ArrayBuffer(
					WAV_HEADER_SIZE + totalPcmSize,
				);
				const wavView = new Uint8Array(wavBuffer);
				let offset = WAV_HEADER_SIZE;
				for (const path of target.segmentPaths) {
					const segment = await adapter.readBinary(path);
					if (offset + segment.byteLength > wavView.byteLength) {
						throw new Error(
							'PCM segment changed during WAV assembly',
						);
					}
					wavView.set(new Uint8Array(segment), offset);
					offset += segment.byteLength;
				}
				// The header is written last with the actual byte count,
				// in case a segment shrank between stat and read
				const header = createWavHeader(
					target.pcmChannels,
					target.pcmSampleRate,
					offset - WAV_HEADER_SIZE,
				);
				wavView.set(new Uint8Array(header), 0);
				return offset === wavBuffer.byteLength
					? wavBuffer
					: wavBuffer.slice(0, offset);
			}
		}

		// Fallback for adapters without stat(): read everything, then
		// assemble (two full copies of the recording in memory)
		const segments = await Promise.all(
			target.segmentPaths.map((path) => adapter.readBinary(path)),
		);
		return assembleWavFromPcmSegments(
			segments,
			target.pcmChannels,
			target.pcmSampleRate,
		);
	}

	/**
	 * Builds a WAV blob from the flushed PCM segments of a target,
	 * flushing any remaining buffered PCM data first.
	 * @param target - Recording target
	 * @returns WAV blob, or null when the target holds no audio
	 */
	private async buildPcmTrackWavBlob(
		target: RecordingTarget,
	): Promise<Blob | null> {
		if (
			target.segmentPaths.length === 0 &&
			target.pcmBuffers.length === 0
		) {
			return null;
		}

		await this.writeQueue.flushPcmBuffer(target);

		if (target.segmentPaths.length === 0) {
			return null;
		}

		return new Blob([await this.buildWavBufferFromSegments(target)], {
			type: 'audio/wav',
		});
	}

	/**
	 * Builds a single blob from the flushed segments and remaining
	 * buffered chunks of a MediaRecorder target.
	 * @param target - Recording target
	 * @returns Combined blob, or null when the target holds no audio
	 */
	private async buildTrackBlob(
		target: RecordingTarget,
	): Promise<Blob | null> {
		const session = this.requireSession();
		if (
			target.segmentPaths.length === 0 &&
			target.bufferedChunks.length === 0
		) {
			return null;
		}

		const type = buildMimeType(session.recorderFormat);
		const segmentBuffers = await Promise.all(
			target.segmentPaths.map((path) =>
				this.app.vault.adapter.readBinary(path),
			),
		);

		return new Blob([...segmentBuffers, ...target.bufferedChunks], {
			type,
		});
	}
}
