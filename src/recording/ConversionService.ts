/**
 * Pipeline for converting an audio file to another format. Extracted
 * from the conversion dialog so the modal stays a form.
 * @module recording/ConversionService
 */

import { normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { ChannelMode, isMonoChannelMode } from '../audio/downmix';
import { convertBlobToFormatBuffer } from '../audio/AudioFormatConverter';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { isReadableSize, tooLargeMessage } from '../platform/capabilities';
import type { ConversionLinkAction } from '../settings/settingsSchema';
import { errorMessage } from '../errors';
import { SourceReplacer } from './SourceReplacer';
import { showNotice, type Notify } from '../utils/notify';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import { kilohertz } from '../audio/AudioCapabilityDetector';
import { AUDIO_EXTENSIONS, PLUGIN_LOG_PREFIX } from '../constants';
import {
	NEVER_CANCELLED,
	throwIfCancelled,
	type CancellationToken,
} from '../utils/cancellation';

/**
 * The formats a recording can be converted to on this device. The source's
 * own format is left out of a conversion that keeps the channels, since the
 * same format in and out would only be a lossy re-encode, and offered for
 * the mono modes, so a stereo file can become a mono one of its format.
 * Shared by the conversion dialog and the command line.
 * @param sourceFormat - The source extension, lower case
 * @param channelMode - The channel layout asked for
 * @returns The target formats, in the order the dialog lists them
 */
export function conversionTargets(
	sourceFormat: string,
	channelMode: ChannelMode,
): string[] {
	return AUDIO_EXTENSIONS.filter(
		(format) =>
			isOfflineEncodingSupported(format) &&
			(format !== sourceFormat || isMonoChannelMode(channelMode)),
	);
}

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
 * Outcome of a conversion. Failure details are already told to the
 * user through the service's reporter, a notice unless the caller passed
 * another. A cancelled conversion says nothing: the user asked for it.
 */
export type ConversionOutcome =
	| { status: 'completed'; newFileName: string; newPath: string }
	| { status: 'aborted' }
	| { status: 'cancelled' }
	| { status: 'partial' };

/**
 * Converts audio files and finishes with link updates and optional
 * source deletion.
 */
export class ConversionService {
	/** Points links at the converted file and removes the source. */
	private readonly sourceReplacer: SourceReplacer;

	/**
	 * Creates a new ConversionService.
	 * @param app - The Obsidian App instance
	 * @param getWorkerClient - The encoding worker, when one is running
	 * @param notify - Where failures and warnings are told to the user
	 */
	constructor(
		private readonly app: App,
		private readonly getWorkerClient: () => EncodingWorkerClient | null = () =>
			null,
		private readonly notify: Notify = showNotice,
	) {
		this.sourceReplacer = new SourceReplacer(app, notify);
	}

	/**
	 * Executes the conversion pipeline: existence pre-check, convert, write
	 * the converted file, update links, optionally delete the source.
	 * Failures before the converted file exists abort the conversion;
	 * failures after that are reported as partial success.
	 *
	 * A cancel is honoured until the converted file is written, and leaves
	 * the vault as it found it: a file written just as the cancel arrived
	 * goes to the trash, and no link is touched. From the write on, the
	 * links and the source are finished the way the request asked, because
	 * stopping halfway through rewriting them would leave notes pointing
	 * at both files.
	 * @param request - Conversion parameters
	 * @param onProgress - Receives pipeline progress text
	 * @param token - Cancels the conversion
	 * @returns Conversion outcome
	 */
	async convert(
		request: ConversionRequest,
		onProgress: (text: string) => void,
		token: CancellationToken = NEVER_CANCELLED,
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
				this.notify(
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
				this.notify(
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
				this.notify(tooLargeMessage('convert'));
				return { status: 'aborted' };
			}

			throwIfCancelled(token);
			onProgress('Reading source file...');
			// Read through the vault rather than its adapter: the file is in
			// hand, and the Vault API is the one Obsidian asks plugins to use
			// for a file it indexes, leaving the adapter to paths it does not.
			const arrayBuffer = await this.app.vault.readBinary(
				request.sourceFile,
			);
			throwIfCancelled(token);

			onProgress('Converting...');
			// One ladder for every target, WAV included: the streaming
			// Conversion writes WAV as well as any compressed format, so a
			// WAV target is demuxed and decoded packet by packet into the
			// output instead of being expanded whole into an AudioBuffer
			// first. The full decode stays on the ladder's last rung, for a
			// platform without the decoder the stream needs. Bytes go
			// straight to createBinary; the buffer variant avoids wrapping
			// the result in a Blob only to read it back out.
			const { data, sampleRateChange } = await convertBlobToFormatBuffer(
				new Blob([arrayBuffer]),
				request.targetFormat,
				request.bitrate,
				(percent) => {
					onProgress(`Converting... ${String(percent)}%`);
				},
				{
					workerClient: this.getWorkerClient(),
					channelMode: request.channelMode ?? ChannelMode.Source,
					cancellation: token,
				},
			);

			throwIfCancelled(token);
			onProgress('Saving...');
			createdFile = await this.app.vault.createBinary(newPath, data);
			if (token.isCancelled()) {
				try {
					await this.app.fileManager.trashFile(createdFile);
				} catch (cleanupError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to remove the converted file after a cancel:`,
						{ path: newPath, cleanupError },
					);
				}
				onProgress('');
				return { status: 'cancelled' };
			}
			// Said once the file exists, since the sentence is about it.
			if (sampleRateChange) {
				const { from, to } = sampleRateChange;
				this.notify(
					`"${newFileName}" was resampled from ${kilohertz(from)} kHz to ${kilohertz(to)} kHz, because the ${request.targetFormat.toUpperCase()} encoder on this device does not take ${kilohertz(from)} kHz.`,
				);
			}
		} catch (error) {
			// Asked of the token rather than of the error, which arrives in
			// whatever shape the step the cancel interrupted fails with.
			if (token.isCancelled()) {
				onProgress('');
				return { status: 'cancelled' };
			}
			const message = errorMessage(error);
			onProgress(`Error: ${message}`);
			this.notify(`Conversion failed: ${message}`);
			return { status: 'aborted' };
		}

		// The converted file exists on disk from here on
		const finished = await this.sourceReplacer.replace(
			request,
			{
				files: [createdFile],
				created: `"${newFileName}" was created`,
				frontmatterAdvice: ' and must be updated manually.',
			},
			onProgress,
		);
		if (!finished) {
			return { status: 'partial' };
		}

		return { status: 'completed', newFileName, newPath };
	}
}
