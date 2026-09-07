/**
 * The recording's output format, its bitrate, and the summary derived from
 * both.
 *
 * Neither list is declared. Which formats an install can encode is settled by
 * an asynchronous probe, and the bitrates one of them reaches depend on the
 * chosen format and sample rate and are blocked per option by the same probe.
 * A declared dropdown carries a fixed option map and disables only as a whole,
 * so both rows are drawn by hand.
 * @module settings/sections/outputFormatSection
 */

import { CONVERSION_LINK_ACTION_LABELS } from '../labels';
import { type OutputFormatRows, SETTINGS_SECTION_CLASS } from './context';
import type { Setting, SettingDefinitionItem } from 'obsidian';

/**
 * The recorded file's format, its bitrate, and what a conversion does with the
 * source file it replaces.
 * @param rows - The three rows that cannot be expressed as controls
 */
export function outputFormatGroup(
	rows: OutputFormatRows,
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
				desc: 'Compression quality and resulting file size. The lowest values are a mono speech mode, small enough to send an hour as one transcription request, and they cost real quality on music or stereo. Values the chosen format and sample rate cannot reach are shown blocked.',
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
