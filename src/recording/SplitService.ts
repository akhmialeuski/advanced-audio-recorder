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
import {
	isDecodableSize,
	isReadableSize,
	tooLargeMessage,
} from '../platform/capabilities';
import { decodeAudioBlob } from '../audio/AudioFormatConverter';
import {
	parseWavLayout,
	buildWavPart,
	buildWavPartRange,
	computeCutRanges,
	computeWavPartBytes,
	sliceAudioBuffer,
	wavFrameOffset,
	computePartCount,
	buildPartFileName,
	type WavLayout,
} from './AudioSplitter';
import { toFileNameSegment, uniqueName } from '../utils/fileNames';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
import { delay } from '../utils/TimeUtils';
import type { ConversionLinkAction } from '../settings/settingsSchema';

/**
 * The way out of a desktop size ceiling for the splitter, which cannot use
 * the generic one: telling a user that a file is too large to split, and that
 * they should split it first, sends them back to the button that just
 * refused. What is true instead is the reason the ceiling exists. It bounds
 * the decode, and a WAV file with raw sample data never reaches one - its
 * parts are copied straight out of the source, at any size.
 */
const SPLIT_DESKTOP_ADVICE =
	'Only a WAV source splits at this size, because its parts are copied ' +
	'rather than decoded.';

/**
 * Parameters of one split operation.
 */
/** One part of a split made at chapter boundaries. */
export interface ChapterCut {
	/** Where the part begins, in seconds. */
	startSeconds: number;
	/** The chapter's title, which names the part's file. */
	title: string;
}

export interface SplitRequest {
	/** File to split. */
	sourceFile: TFile;
	/** Part duration in seconds; ignored when {@link cuts} is given. */
	partSeconds: number;
	/**
	 * Where to cut, when the split follows the recording's chapters rather
	 * than a fixed length. The parts are then of different lengths and each
	 * is named after its chapter.
	 */
	cuts?: readonly ChapterCut[];
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
			// Platform ceiling on the full-file read itself, checked
			// BEFORE the bytes are materialized: on mobile, even holding
			// the source (plus one part copy) can get the WebView killed.
			// Desktop is unbounded here - the lossless WAV byte path must
			// keep splitting files beyond the decode ceiling.
			if (!isReadableSize(request.sourceFile.stat.size)) {
				new Notice(
					tooLargeMessage('split', {
						desktopAdvice: SPLIT_DESKTOP_ADVICE,
					}),
				);
				onProgress('');
				return { status: 'aborted' };
			}
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
			firstPartName = partNames[0] ?? '';
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
			if (layout && request.cuts) {
				return chapterWavParts(
					request.cuts,
					baseName,
					sourceBytes,
					layout,
				);
			}
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

		// Platform-dependent decode ceiling (far lower on mobile): the
		// decode path expands the file to full PCM in memory. The lossless
		// WAV byte path above never decodes, so it is not capped here.
		if (!isDecodableSize(sourceBytes.byteLength)) {
			new Notice(
				tooLargeMessage('split', {
					desktopAdvice: SPLIT_DESKTOP_ADVICE,
				}),
			);
			return null;
		}

		onProgress('Decoding audio...');
		const audioBuffer = await decodeAudioBlob(sourceBytes, 'split');
		const partSamples = request.partSeconds * audioBuffer.sampleRate;
		// A chapter split has no fixed part length to be shorter than: its
		// parts are as long as the chapters make them.
		if (!request.cuts && audioBuffer.length <= partSamples) {
			new Notice('File is shorter than one part.');
			return null;
		}

		const targetFormat = this.getTargetExtension(request.sourceFile);
		if (targetFormat !== sourceExtension) {
			new Notice(
				`Encoding to "${sourceExtension}" is unavailable; parts are saved as WAV.`,
			);
		}

		if (request.cuts) {
			return chapterDecodedParts(
				request,
				request.cuts,
				baseName,
				targetFormat,
				audioBuffer,
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
				const part = parts[i];
				const partPath = partPaths[i];
				if (!part || !partPath) {
					continue;
				}
				const bytes = await part.data();
				const created = await this.app.vault.createBinary(
					partPath,
					bytes,
				);
				written.push({
					path: partPath,
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

/**
 * The parts a chapter split cuts an uncompressed WAV into, without decoding.
 * @param cuts - Where the parts begin, and what each is called
 * @param baseName - Name of the recording, used when a title yields nothing
 * @param sourceBytes - Raw WAV file bytes
 * @param layout - Parsed WAV layout
 * @returns The parts, each built lazily so one buffer is alive at a time
 */
function chapterWavParts(
	cuts: readonly ChapterCut[],
	baseName: string,
	sourceBytes: ArrayBuffer,
	layout: WavLayout,
): PreparedPart[] {
	const taken = new Set<string>();
	return computeCutRanges(
		cuts,
		wavFrameOffset(layout),
		layout.dataLength,
	).map((range, index) => ({
		fileName: chapterPartName(
			range.cut,
			index,
			baseName,
			FORMAT_WAV,
			taken,
		),
		data: () =>
			Promise.resolve(
				buildWavPartRange(sourceBytes, layout, range.start, range.end),
			),
	}));
}

/**
 * The parts a chapter split cuts a decoded recording into.
 * @param request - The split being performed
 * @param cuts - Where the parts begin, and what each is called
 * @param baseName - Name of the recording, used when a title yields nothing
 * @param targetFormat - Extension the parts are encoded to
 * @param audioBuffer - The decoded recording
 * @returns The parts, each encoded lazily
 */
function chapterDecodedParts(
	request: SplitRequest,
	cuts: readonly ChapterCut[],
	baseName: string,
	targetFormat: string,
	audioBuffer: AudioBuffer,
): PreparedPart[] {
	const taken = new Set<string>();
	return computeCutRanges(
		cuts,
		(seconds) => Math.floor(Math.max(0, seconds) * audioBuffer.sampleRate),
		audioBuffer.length,
	).map((range, index) => ({
		fileName: chapterPartName(
			range.cut,
			index,
			baseName,
			targetFormat,
			taken,
		),
		data: async () => {
			const slice = sliceAudioBuffer(audioBuffer, range.start, range.end);
			const blob = await encodeAudioBuffer(slice, {
				format: targetFormat,
				bitrate: request.bitrate,
			});
			return blob.arrayBuffer();
		},
	}));
}

/**
 * The file name of one part: the chapter's title made safe, numbered when two
 * chapters share one, and the recording's own name when the part opens no
 * chapter (the audio before the first) or when a title survives sanitising as
 * nothing at all.
 * @param cut - The chapter the part opens, or null when it opens none
 * @param index - Which part is being named
 * @param baseName - Name of the recording
 * @param extension - Extension of the part
 * @param taken - Names already used by this split
 * @returns The part's file name
 */
function chapterPartName(
	cut: ChapterCut | null,
	index: number,
	baseName: string,
	extension: string,
	taken: Set<string>,
): string {
	const segment = toFileNameSegment(
		cut?.title ?? '',
		`${baseName}-${String(index + 1)}`,
	);
	return `${uniqueName(segment, taken)}.${extension}`;
}
