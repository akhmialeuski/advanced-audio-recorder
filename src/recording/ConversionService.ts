/**
 * Pipeline for converting an audio file to another format. Extracted
 * from the conversion dialog so the modal stays a form.
 * @module recording/ConversionService
 */

import { Notice, normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { ChannelMode, isMonoChannelMode } from '../audio/downmix';
import { convertBlobToFormatBuffer } from '../audio/AudioFormatConverter';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { isReadableSize, tooLargeMessage } from '../platform/capabilities';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
import { ConversionLinkAction } from '../settings/settingsSchema';

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
	/**
	 * Channel layout for the converted file: keep the source layout or
	 * downmix to mono (mix or one picked channel). Optional so existing
	 * callers keep their channel-preserving behavior.
	 */
	channelMode?: ChannelMode;
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
	constructor(
		private readonly app: App,
		private readonly getWorkerClient: () => EncodingWorkerClient | null = () =>
			null,
	) {}

	/**
	 * Executes the conversion pipeline: existence pre-check, convert, write
	 * the converted file, update links, optionally delete the source. Failures before the converted file exists abort
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
		let newFileName = `${baseName}.${request.targetFormat}`;
		let newPath = normalizePath(
			directory ? `${directory}/${newFileName}` : newFileName,
		);
		// Compared case-insensitively on the extension, not by path
		// equality: a `.WAV` source converting to `wav` produces a path
		// that differs only in case, which still collides on Windows and
		// would create a case-twin file on case-sensitive systems
		const isSameFormat =
			request.targetFormat.toLowerCase() ===
			request.sourceFile.extension.toLowerCase();
		if (isSameFormat) {
			// Same-format conversion exists only to downmix (the dialog
			// offers the source format for the mono modes alone); the
			// output gets its own name instead of colliding with the
			// source, and a channel-preserving request is refused because
			// it would just re-encode the file into itself
			if (!isMonoChannelMode(request.channelMode ?? ChannelMode.Source)) {
				new Notice(
					'Converting to the same format requires a mono channels option.',
				);
				return { status: 'aborted' };
			}
			newFileName = `${baseName}-mono.${request.targetFormat}`;
			newPath = normalizePath(
				directory ? `${directory}/${newFileName}` : newFileName,
			);
		}

		let createdFile: TFile;
		try {
			// Check if target file already exists
			if (await this.app.vault.adapter.exists(newPath)) {
				new Notice(
					`File "${newFileName}" already exists. Choose a different format or rename the existing file.`,
				);
				return { status: 'aborted' };
			}

			// The ceiling on the read, which is what happens next, and not
			// the one on decoding: the conversion below remuxes or streams,
			// and neither ever expands the file to PCM. Asking the decode
			// question here would refuse a long recording that the converter
			// handles without allocating for it. What decoding costs is
			// bounded by decodeAudioBlob, where the allocation is, on the
			// last rung of the ladder.
			if (!isReadableSize(request.sourceFile.stat.size)) {
				new Notice(tooLargeMessage('convert'));
				return { status: 'aborted' };
			}

			onProgress('Reading source file...');
			// Read through the vault rather than its adapter: the file is in
			// hand, and the Vault API is the one Obsidian asks plugins to use
			// for a file it indexes, leaving the adapter to paths it does not.
			const arrayBuffer = await this.app.vault.readBinary(
				request.sourceFile,
			);

			onProgress('Converting...');
			// One ladder for every target, WAV included: the streaming
			// Conversion writes WAV as well as any compressed format, so a
			// WAV target is demuxed and decoded packet by packet into the
			// output instead of being expanded whole into an AudioBuffer
			// first. The full decode stays on the ladder's last rung, for a
			// platform without the decoder the stream needs. Bytes go
			// straight to createBinary; the buffer variant avoids wrapping
			// the result in a Blob only to read it back out.
			const data = await convertBlobToFormatBuffer(
				new Blob([arrayBuffer]),
				request.targetFormat,
				request.bitrate,
				(percent) => {
					onProgress(`Converting... ${String(percent)}%`);
				},
				{
					workerClient: this.getWorkerClient(),
					channelMode: request.channelMode ?? ChannelMode.Source,
				},
			);

			onProgress('Saving...');
			createdFile = await this.app.vault.createBinary(newPath, data);
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
		if (request.linkAction !== ConversionLinkAction.None) {
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
