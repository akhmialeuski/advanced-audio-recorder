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

import { CONVERSION_LINK_ACTION_LABELS } from '../labels';
import { takesBitrate } from '../../audio/formatRegistry';
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
				name: 'Audio bitrate',
				aliases: ['quality', 'kbps'],
				desc: BITRATE_ROW_DESC,
				// WAV is uncompressed PCM and carries no bitrate at all, so
				// the row described something the file does not have. Stated
				// as a predicate rather than hidden from inside the render
				// callback, because the renderer re-applies this after every
				// change and would put the row back.
				visible: (): boolean => takesBitrate(settings.recordingFormat),
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
