/**
 * Pipeline for splitting an audio file into time-based parts. WAV
 * files with a raw sample data chunk are split losslessly at the byte
 * level; compressed formats are decoded once and re-encoded per part.
 * Extracted from the split dialog so the modal stays a form.
 * @module recording/SplitService
 */

import { Notice, TFile, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
} from '../audio/AudioEncoder';
import { FORMAT_WAV, PLUGIN_LOG_PREFIX } from '../constants';
import { decodeAudioBlob } from '../audio/AudioFormatConverter';
import {
	parseWavLayout,
	buildWavPart,
	computeWavPartBytes,
	sliceAudioBuffer,
	computePartCount,
	buildPartFileName,
} from './AudioSplitter';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
import { delay } from '../utils/TimeUtils';
import type { ConversionLinkAction } from '../settings/settingsSchema';

/**
 * Parameters of one split operation.
 */
export interface SplitRequest {
	/** File to split. */
	sourceFile: TFile;
	/** Part duration in seconds. */
	partSeconds: number;
	/** Validated part name suffix. */
	suffix: string;
	/** Bitrate for re-encoding compressed parts. */
	bitrate: number;
	/** Whether to delete the source file after a successful split. */
	deleteSource: boolean;
	/** How to rewrite links to the source file. */
	linkAction: ConversionLinkAction;
}

/**
 * Outcome of a split operation. Failure details are already surfaced
 * to the user via Notices by the pipeline.
 */
export type SplitOutcome =
	| { status: 'completed'; partCount: number; firstPartName: string }
	| { status: 'aborted' }
	| { status: 'partial' };

/** Lazily built part: the data callback keeps at most one part alive. */
interface PreparedPart {
	fileName: string;
	data: () => Promise<ArrayBuffer>;
}

/**
 * Splits audio files into part files and finishes with link updates
 * and optional source deletion.
 */
export class SplitService {
	/**
	 * Creates a new SplitService.
	 * @param app - The Obsidian App instance
	 */
	constructor(private readonly app: App) {}

	/**
	 * Resolves the extension the part files will get: WAV sources stay
	 * WAV; compressed sources keep their format when an offline encoder
	 * exists and fall back to WAV otherwise.
	 * @param sourceFile - File being split
	 * @returns Part file extension without the dot
	 */
	getTargetExtension(sourceFile: TFile): string {
		const sourceExtension = sourceFile.extension.toLowerCase();
		if (
			sourceExtension === FORMAT_WAV ||
			!isOfflineEncodingSupported(sourceExtension)
		) {
			return FORMAT_WAV;
		}
		return sourceExtension;
	}

	/**
	 * Executes the split pipeline: prepare parts, pre-check collisions,
	 * write part files, update links, optionally delete the source.
	 * Failures before any part is written abort the whole split;
	 * failures after that are reported as partial success, because the
	 * part files already exist on disk and a repeated run would abort
	 * on the collision pre-check.
	 * @param request - Split parameters
	 * @param onProgress - Receives pipeline progress text
	 * @returns Split outcome
	 */
	async split(
		request: SplitRequest,
		onProgress: (text: string) => void,
	): Promise<SplitOutcome> {
		let partFiles: TFile[];
		let partCount: number;
		let firstPartName: string;
		try {
			onProgress('Reading source file...');
			const sourceBytes = await this.app.vault.adapter.readBinary(
				request.sourceFile.path,
			);

			const parts = await this.preparePartBlobs(
				request,
				sourceBytes,
				onProgress,
			);
			if (!parts) {
				onProgress('');
				return { status: 'aborted' };
			}

			const partNames = parts.map((part) => part.fileName);
			const partPaths = await this.resolvePartPaths(
				request.sourceFile,
				partNames,
			);
			if (!partPaths) {
				onProgress('');
				return { status: 'aborted' };
			}

			partFiles = await this.writePartFiles(parts, partPaths, onProgress);
			partCount = parts.length;
			firstPartName = partNames[0];
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			onProgress(`Error: ${message}`);
			new Notice(`Split failed: ${message}`);
			return { status: 'aborted' };
		}

		// The parts exist on disk from here on
		if (!(await this.finishSplit(request, partFiles, onProgress))) {
			return { status: 'partial' };
		}

		return { status: 'completed', partCount, firstPartName };
	}

	/**
	 * Post-write pipeline steps: updates links and optionally deletes
	 * the source file. The part files already exist, so errors here are
	 * reported as partial success and never as a failed split. The
	 * source file is kept when some links could not be updated, because
	 * deleting it would leave those links broken.
	 * @param request - Split parameters
	 * @param partFiles - Created part files in write order
	 * @param onProgress - Receives pipeline progress text
	 * @returns True when every requested step succeeded
	 */
	private async finishSplit(
		request: SplitRequest,
		partFiles: TFile[],
		onProgress: (text: string) => void,
	): Promise<boolean> {
		let linkResult: VaultLinkUpdateResult | null = null;
		if (request.linkAction !== 'none') {
			onProgress('Updating links...');
			try {
				linkResult = await updateLinksInVault(
					this.app,
					request.sourceFile,
					partFiles,
					request.linkAction,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				onProgress(`Error: ${message}`);
				new Notice(
					`Parts were created, but updating links failed: ${message}. The source file was kept.`,
				);
				return false;
			}
			if (linkResult.frontmatterReferences > 0) {
				new Notice(
					`${String(linkResult.frontmatterReferences)} frontmatter link(s) still point to the source file: properties cannot hold several links.`,
				);
			}
		}

		if (request.deleteSource) {
			if (linkResult !== null && linkResult.skippedReferences > 0) {
				new Notice(
					`Source file kept: ${String(linkResult.skippedReferences)} link(s) could not be updated.`,
				);
			} else {
				onProgress('Removing source file...');
				try {
					await this.app.fileManager.trashFile(request.sourceFile);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					onProgress(`Error: ${message}`);
					new Notice(
						`Parts were created, but the source file could not be deleted: ${message}`,
					);
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * Builds part blobs from the source bytes. WAV sources with a raw
	 * sample data chunk are split byte-exactly without decoding; other
	 * formats are decoded once and re-encoded per part.
	 * @param request - Split parameters
	 * @param sourceBytes - Raw bytes of the source file
	 * @param onProgress - Receives pipeline progress text
	 * @returns Parts with target file names, or null when splitting
	 * is not possible (a Notice explains why)
	 */
	private async preparePartBlobs(
		request: SplitRequest,
		sourceBytes: ArrayBuffer,
		onProgress: (text: string) => void,
	): Promise<PreparedPart[] | null> {
		const baseName = request.sourceFile.basename;
		const sourceExtension = request.sourceFile.extension.toLowerCase();

		if (sourceExtension === FORMAT_WAV) {
			const layout = parseWavLayout(sourceBytes);
			if (layout) {
				const partBytes = computeWavPartBytes(
					layout,
					request.partSeconds,
				);
				if (partBytes <= 0 || layout.dataLength <= partBytes) {
					new Notice('File is shorter than one part.');
					return null;
				}
				const partCount = computePartCount(
					layout.dataLength,
					partBytes,
				);
				return Array.from({ length: partCount }, (_, index) => ({
					fileName: buildPartFileName(
						baseName,
						request.suffix,
						index + 1,
						FORMAT_WAV,
					),
					// Built lazily inside data() so at most one part
					// buffer is alive at a time while writing files that
					// can be gigabytes in size
					data: () =>
						Promise.resolve(
							buildWavPart(sourceBytes, layout, partBytes, index),
						),
				}));
			}
			// Non-raw WAV (compressed codec inside): fall through to decode
		}

		onProgress('Decoding audio...');
		const audioBuffer = await decodeAudioBlob(sourceBytes);
		const partSamples = request.partSeconds * audioBuffer.sampleRate;
		if (audioBuffer.length <= partSamples) {
			new Notice('File is shorter than one part.');
			return null;
		}

		const targetFormat = this.getTargetExtension(request.sourceFile);
		if (targetFormat !== sourceExtension) {
			new Notice(
				`Encoding to "${sourceExtension}" is unavailable; parts are saved as WAV.`,
			);
		}

		const partCount = computePartCount(audioBuffer.length, partSamples);
		return Array.from({ length: partCount }, (_, index) => ({
			fileName: buildPartFileName(
				baseName,
				request.suffix,
				index + 1,
				targetFormat,
			),
			data: async () => {
				const slice = sliceAudioBuffer(
					audioBuffer,
					index * partSamples,
					(index + 1) * partSamples,
				);
				const blob = await encodeAudioBuffer(slice, {
					format: targetFormat,
					bitrate: request.bitrate,
				});
				return blob.arrayBuffer();
			},
		}));
	}

	/**
	 * Resolves full vault paths for all parts and aborts when any
	 * target file already exists.
	 * @param sourceFile - File being split
	 * @param partNames - Part file names
	 * @returns Normalized part paths, or null on collision
	 */
	private async resolvePartPaths(
		sourceFile: TFile,
		partNames: string[],
	): Promise<string[] | null> {
		const directory = sourceFile.parent?.path ?? '';
		const paths = partNames.map((name) =>
			normalizePath(directory ? `${directory}/${name}` : name),
		);
		for (const path of paths) {
			if (await this.app.vault.adapter.exists(path)) {
				new Notice(
					`File "${path}" already exists. Rename it or choose a different suffix.`,
				);
				return null;
			}
		}
		return paths;
	}

	/**
	 * Writes all part files, yielding to the UI between parts.
	 * On failure removes already-written parts and rethrows, keeping
	 * the source file intact.
	 * @param parts - Prepared parts in order
	 * @param partPaths - Resolved part paths
	 * @param onProgress - Receives pipeline progress text
	 * @returns The created part files in write order
	 */
	private async writePartFiles(
		parts: PreparedPart[],
		partPaths: string[],
		onProgress: (text: string) => void,
	): Promise<TFile[]> {
		const written: { path: string; file: TFile | null }[] = [];
		try {
			for (let i = 0; i < parts.length; i++) {
				onProgress(
					`Writing part ${String(i + 1)} of ${String(parts.length)}...`,
				);
				const bytes = await parts[i].data();
				const created = await this.app.vault.createBinary(
					partPaths[i],
					bytes,
				);
				written.push({
					path: partPaths[i],
					file: created instanceof TFile ? created : null,
				});
				// Yield to the UI between parts so the progress text repaints
				await delay(0);
			}
		} catch (error) {
			for (const part of written) {
				try {
					if (part.file) {
						// trashFile respects the user's file deletion
						// preference and keeps the rollback recoverable
						await this.app.fileManager.trashFile(part.file);
					} else {
						await this.app.vault.adapter.remove(part.path);
					}
				} catch (cleanupError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to remove part after split error:`,
						{ path: part.path, cleanupError },
					);
				}
			}
			throw error;
		}
		return written.flatMap((part) => (part.file ? [part.file] : []));
	}
}
