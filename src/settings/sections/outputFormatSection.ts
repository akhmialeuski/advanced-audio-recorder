/**
 * The recording's output format, its bitrate, and the summary derived from
 * both.
 *
 * The format list itself is drawn by hand: which options an install can encode
 * is settled by an asynchronous probe, so the row cannot be declared.
 * @module settings/sections/outputFormatSection
 */

import { CONVERSION_LINK_ACTION_LABELS } from '../labels';
import { type OutputFormatRows, SETTINGS_SECTION_CLASS } from './context';
import type { Setting, SettingDefinitionItem } from 'obsidian';

/** Bitrates the output-format section offers, in kbps. */
const BITRATE_OPTIONS_KBPS = [64, 96, 128, 160, 192, 256, 320];

/**
 * The recorded file's format, its bitrate, and what a conversion does with the
 * source file it replaces.
 * @param rows - The two rows that cannot be expressed as controls
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
				desc: 'Compression quality and resulting file size.',
				control: {
					type: 'dropdown',
					key: 'bitrate',
					options: Object.fromEntries(
						BITRATE_OPTIONS_KBPS.map((kbps) => [
							String(kbps * 1000),
							`${String(kbps)} kbps`,
						]),
					),
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
