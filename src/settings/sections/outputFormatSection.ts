/**
 * The recording's output format, its bitrate, and the summary derived from
 * both.
 *
 * Neither list is declared. Which formats an install can encode is settled by
 * an asynchronous probe, and which bitrates one of them reaches depends on the
 * chosen format, the sample rate and the same probe, so the list is rebuilt
 * each time one of those moves. A declared dropdown carries a fixed option map
 * and a fixed description, so both rows are drawn by hand.
 * @module settings/sections/outputFormatSection
 */

import {
	CONVERSION_LINK_ACTION_LABELS,
	PCM_SAMPLE_FORMAT_LABELS,
} from '../labels';
import { recordingBitrateFormat } from '../../audio/AudioFormatConverter';
import { isPcmWavCaptureSupported } from '../../platform/capabilities';
import type { AudioRecorderSettings } from '../settingsSchema';
import { type OutputFormatRows, SETTINGS_SECTION_CLASS } from './context';
import type { Setting, SettingDefinitionItem } from 'obsidian';

/**
 * What the bitrate row says before the format, the sample rate and the encoder
 * have narrowed the list. The tab re-describes the row as those answers land,
 * appending a sentence naming what decided the values on offer, and it needs
 * this half back to put in front of it.
 */
export const BITRATE_ROW_DESC =
	'Compression quality and resulting file size. The lowest values are a mono speech mode, small enough to send an hour as one transcription request, and they cost real quality on music or stereo.';

/**
 * What the bit depth row says, given whether this device records WAV as raw
 * PCM at all.
 *
 * The row stays offered on a device that does not, for the reason the system
 * audio switch stays offered there: a vault synced from a machine that records
 * raw PCM carries the choice, and a user who cannot see the setting cannot
 * move it back either.
 * @param pcmCapture - Whether this platform captures WAV as raw PCM
 * @returns The row's description
 */
function bitDepthRowDesc(pcmCapture: boolean): string {
	const base =
		'How much of each sample a WAV recording keeps. Sixteen bits is enough ' +
		'for speech at a level set carefully in advance; twenty-four leave room ' +
		'under a speaker quieter than expected, and thirty-two floating point ' +
		'keep a sample that went past full scale instead of flattening it, so an ' +
		'overloaded recording is recovered by normalizing the file afterwards. ' +
		'A wider sample costs file size in proportion.';
	return pcmCapture
		? `${base} Applies to WAV recordings only; every other format carries the width its encoder writes.`
		: `${base} Not available on this device, which records WAV through a compressed intermediate rather than as raw PCM.`;
}

/**
 * The recorded file's format, its bitrate, and what a conversion does with the
 * source file it replaces.
 * @param rows - The three rows that cannot be expressed as controls
 * @param settings - Live settings, read by the bitrate row's own predicate
 * @returns The group definition
 */
export function outputFormatGroup(
	rows: OutputFormatRows,
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Output format',
		items: [
			{
				name: 'Recording format',
				aliases: ['codec', 'container', 'mp3', 'wav', 'webm', 'm4a'],
				desc: 'Final file format. Formats this device cannot record are shown blocked.',
				render: (setting: Setting): void => {
					rows.renderFormatRow(setting);
				},
			},
			{
				name: 'Bit depth',
				aliases: [
					'24-bit',
					'32-bit',
					'float',
					'headroom',
					'sample format',
					'resolution',
					'pcm',
				],
				desc: bitDepthRowDesc(isPcmWavCaptureSupported()),
				control: {
					type: 'dropdown',
					key: 'recordingBitDepth',
					options: PCM_SAMPLE_FORMAT_LABELS,
					// Off where WAV is not captured as raw PCM: the width
					// would then be the intermediate encoder's to state, and
					// nothing here could honour the choice.
					disabled: (): boolean => !isPcmWavCaptureSupported(),
				},
			},
			{
				name: 'Audio bitrate',
				aliases: ['quality', 'kbps'],
				desc: BITRATE_ROW_DESC,
				// WAV captured as raw PCM carries no bitrate at all, so the
				// row described something the file does not have. Asked of
				// the capture rather than of the container: FLAC, and WAV on
				// a platform without PCM capture, are recorded through a
				// compressed intermediate, so the value still decides what
				// the finished file holds and the row has to stay. Stated as
				// a predicate rather than hidden from inside the render
				// callback, because the renderer re-applies this after every
				// change and would put the row back.
				visible: (): boolean =>
					recordingBitrateFormat(settings.recordingFormat) !== null,
				render: (setting: Setting): void => {
					rows.renderBitrateRow(setting);
				},
			},
			{
				name: 'Output summary',
				desc: 'The exact format, compression type, and bitrate used for recording.',
				render: (setting: Setting): void => {
					rows.renderSummaryRow(setting);
				},
			},
			{
				name: 'Delete source after conversion',
				desc: 'Delete the original file after a successful conversion from the context menu.',
				control: {
					type: 'toggle',
					key: 'deleteSourceAfterConversion',
				},
			},
			{
				name: 'Update links after conversion',
				desc: 'What to do with links to the source file in your notes.',
				control: {
					type: 'dropdown',
					key: 'conversionLinkAction',
					options: CONVERSION_LINK_ACTION_LABELS,
				},
			},
		],
	};
}
