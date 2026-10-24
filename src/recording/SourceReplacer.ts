/**
 * The step a conversion and a split end with once their files are written:
 * links to the source are pointed at the new files across the whole vault,
 * notes that are not open included, and the source goes to the trash only
 * when no link still needs it. Kept in one place so the rule for when a source
 * may be deleted cannot drift between the two jobs.
 * @module recording/SourceReplacer
 */

import type { App, TFile } from 'obsidian';
import {
	updateLinksInVault,
	type VaultLinkUpdateResult,
} from '../utils/LinkUpdater';
import { ConversionLinkAction } from '../settings/settingsSchema';
import { errorMessage } from '../errors';
import type { Notify } from '../utils/notify';

/** What a job was asked to do with the file it was made from. */
export interface SourceReplacement {
	/** The file the job read. */
	sourceFile: TFile;
	/** Whether to trash it once the job's files exist. */
	deleteSource: boolean;
	/** How links to it are rewritten. */
	linkAction: ConversionLinkAction;
}

/** The files a job wrote, and how its messages name them. */
export interface WrittenFiles {
	/** The files links are pointed at, in write order. */
	files: TFile[];
	/** Opens a failure after the write, such as `Parts were created`. */
	created: string;
	/**
	 * Ends the warning that frontmatter links still point at the source,
	 * separator included, such as `: properties cannot hold several links.`
	 */
	frontmatterAdvice: string;
}

/**
 * Replaces a job's source with the files the job wrote, for the service that
 * owns it and reports through that service's reporter.
 */
export class SourceReplacer {
	/**
	 * @param app - The Obsidian App instance
	 * @param notify - Where failures and warnings are told to the user
	 */
	constructor(
		private readonly app: App,
		private readonly notify: Notify,
	) {}

	/**
	 * Points links to the source at the written files and trashes the source
	 * when the request asks for it. The files already exist, so a failure
	 * here is told to the user and answered as a partial success. The source
	 * is kept when some links could not be updated, because deleting it would
	 * leave those links broken.
	 * @param request - What was asked for the source
	 * @param written - The files the job wrote
	 * @param onProgress - Receives pipeline progress text
	 * @returns True when every requested step succeeded
	 */
	async replace(
		request: SourceReplacement,
		written: WrittenFiles,
		onProgress: (text: string) => void,
	): Promise<boolean> {
		let linkResult: VaultLinkUpdateResult | null = null;
		if (request.linkAction !== ConversionLinkAction.None) {
			onProgress('Updating links...');
			try {
				linkResult = await updateLinksInVault(
					this.app,
					request.sourceFile,
					written.files,
					request.linkAction,
				);
			} catch (error) {
				const message = errorMessage(error);
				onProgress(`Error: ${message}`);
				this.notify(
					`${written.created}, but updating links failed: ${message}. The source file was kept.`,
				);
				return false;
			}
			if (linkResult.frontmatterReferences > 0) {
				this.notify(
					`${String(linkResult.frontmatterReferences)} frontmatter link(s) still point to the source file${written.frontmatterAdvice}`,
				);
			}
		}

		if (!request.deleteSource) {
			return true;
		}
		if (linkResult !== null && linkResult.skippedReferences > 0) {
			this.notify(
				`Source file kept: ${String(linkResult.skippedReferences)} link(s) could not be updated.`,
			);
			return true;
		}
		onProgress('Removing source file...');
		try {
			await this.app.fileManager.trashFile(request.sourceFile);
		} catch (error) {
			const message = errorMessage(error);
			onProgress(`Error: ${message}`);
			this.notify(
				`${written.created}, but the source file could not be deleted: ${message}`,
			);
			return false;
		}
		return true;
	}
}
