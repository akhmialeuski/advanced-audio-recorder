/**
 * Pipeline for converting an audio file to another format. Extracted
 * from the conversion dialog so the modal stays a form.
 * @module recording/ConversionService
 */

import { Notice, normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { encodeAudioBuffer } from '../audio/AudioEncoder';
import { FORMAT_WAV } from '../constants';
import { decodeAudioBlob, convertBlobToFormat } from '../audio/AudioFormatConverter';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
import type { ConversionLinkAction } from '../settings/Settings';

/**
 * Parameters of one conversion operation.
 */
export interface ConversionRequest {
	/** File to convert. */
	sourceFile: TFile;
	/** Target output format. */
	targetFormat: string;
	/** Bitrate for compressed targets. */
	bitrate: number;
	/** Whether to delete the source file after a successful conversion. */
	deleteSource: boolean;
	/** How to rewrite links to the source file. */
	linkAction: ConversionLinkAction;
}

/**
 * Outcome of a conversion. Failure details are already surfaced to
 * the user via Notices by the pipeline.
 */
export type ConversionOutcome =
	| { status: 'completed'; newFileName: string; newPath: string }
	| { status: 'aborted' }
	| { status: 'partial' };

/**
 * Converts audio files and finishes with link updates and optional
 * source deletion.
 */
export class ConversionService {
	/**
	 * Creates a new ConversionService.
	 * @param app - The Obsidian App instance
	 */
	constructor(private readonly app: App) {}

	/**
	 * Executes the conversion pipeline: existence pre-check, decode or
	 * stream-convert, write the converted file, update links, optionally
	 * delete the source. Failures before the converted file exists abort
	 * the conversion; failures after that are reported as partial
	 * success.
	 * @param request - Conversion parameters
	 * @param onProgress - Receives pipeline progress text
	 * @returns Conversion outcome
	 */
	async convert(
		request: ConversionRequest,
		onProgress: (text: string) => void,
	): Promise<ConversionOutcome> {
		const baseName = request.sourceFile.basename;
		const directory = request.sourceFile.parent?.path ?? '';
		const newFileName = `${baseName}.${request.targetFormat}`;
		const newPath = normalizePath(
			directory ? `${directory}/${newFileName}` : newFileName,
		);

		let createdFile: TFile;
		try {
			// Check if target file already exists
			if (await this.app.vault.adapter.exists(newPath)) {
				new Notice(
					`File "${newFileName}" already exists. Choose a different format or rename the existing file.`,
				);
				return { status: 'aborted' };
			}

			onProgress('Reading source file...');
			const arrayBuffer = await this.app.vault.adapter.readBinary(
				request.sourceFile.path,
			);

			let blob: Blob;
			if (request.targetFormat === FORMAT_WAV) {
				// WAV needs a full decode; the streaming pipeline only
				// targets compressed formats
				onProgress('Decoding audio...');
				const audioBuffer = await decodeAudioBlob(arrayBuffer);
				onProgress('Encoding...');
				blob = await encodeAudioBuffer(
					audioBuffer,
					{
						format: request.targetFormat,
						bitrate: request.bitrate,
					},
					(percent) => {
						onProgress(`Encoding... ${String(percent)}%`);
					},
				);
			} else {
				onProgress('Converting...');
				blob = await convertBlobToFormat(
					new Blob([arrayBuffer]),
					request.targetFormat,
					request.bitrate,
					(percent) => {
						onProgress(`Converting... ${String(percent)}%`);
					},
				);
			}

			onProgress('Saving...');
			createdFile = await this.app.vault.createBinary(
				newPath,
				await blob.arrayBuffer(),
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			onProgress(`Error: ${message}`);
			new Notice(`Conversion failed: ${message}`);
			return { status: 'aborted' };
		}

		// The converted file exists on disk from here on
		if (
			!(await this.finishConversion(
				request,
				createdFile,
				newFileName,
				onProgress,
			))
		) {
			return { status: 'partial' };
		}

		return { status: 'completed', newFileName, newPath };
	}

	/**
	 * Post-write pipeline steps: updates links across the whole vault
	 * (covering notes that are not open, exactly like the split flow)
	 * and optionally deletes the source file. The converted file already
	 * exists, so errors here are reported as partial success. The source
	 * file is kept when some links could not be updated, because
	 * deleting it would leave those links broken.
	 * @param request - Conversion parameters
	 * @param createdFile - The converted file
	 * @param newFileName - Display name of the converted file
	 * @param onProgress - Receives pipeline progress text
	 * @returns True when every requested step succeeded
	 */
	private async finishConversion(
		request: ConversionRequest,
		createdFile: TFile,
		newFileName: string,
		onProgress: (text: string) => void,
	): Promise<boolean> {
		let linkResult: VaultLinkUpdateResult | null = null;
		if (request.linkAction !== 'none') {
			onProgress('Updating links...');
			try {
				linkResult = await updateLinksInVault(
					this.app,
					request.sourceFile,
					[createdFile],
					request.linkAction,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				onProgress(`Error: ${message}`);
				new Notice(
					`"${newFileName}" was created, but updating links failed: ${message}. The source file was kept.`,
				);
				return false;
			}
			if (linkResult.frontmatterReferences > 0) {
				new Notice(
					`${String(linkResult.frontmatterReferences)} frontmatter link(s) still point to the source file and must be updated manually.`,
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
						`"${newFileName}" was created, but the source file could not be deleted: ${message}`,
					);
					return false;
				}
			}
		}
		return true;
	}
}
