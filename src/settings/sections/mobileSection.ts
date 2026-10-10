/**
 * What the plugin shows on a phone or a tablet and nowhere else.
 * @module settings/sections/mobileSection
 */

import { RECORDING_BANNER_ANCHOR_LABELS } from '../labels';
import type { AudioRecorderSettings } from '../settingsSchema';
import { SETTINGS_SECTION_CLASS } from './context';
import type { SettingGroupItem } from 'obsidian';

/**
 * The mobile-only settings, behind an entry of their own. They change nothing
 * on a desktop, yet live in the synced data.json, so they stay reachable there
 * for a vault configured on the desktop and used on the phone.
 * @param settings - Live settings, read by the entry's value and the rows'
 * visibility
 */
export function mobilePage(settings: AudioRecorderSettings): SettingGroupItem {
	const bannerShown = (): boolean => settings.mobileRecordingBanner;
	return {
		type: 'page',
		name: 'Mobile',
		desc: 'What the plugin shows in the Obsidian mobile app.',
		displayValue: (): string =>
			bannerShown()
				? RECORDING_BANNER_ANCHOR_LABELS[
						settings.mobileRecordingBannerPosition
					]
				: 'Off',
		items: [
			{
				type: 'group',
				cls: SETTINGS_SECTION_CLASS,
				heading: 'Recording banner',
				items: [
					{
						name: 'Show recording banner',
						aliases: ['mobile recording banner', 'mobile banner'],
						desc: 'Show a floating banner with the elapsed time and a stop button while recording, since the mobile app has no ribbon indicator.',
						control: {
							type: 'toggle',
							key: 'mobileRecordingBanner',
						},
					},
					{
						name: 'Banner position',
						aliases: ['move banner', 'drag banner'],
						desc: 'Where the banner rests. Dragging the banner moves it to the nearest of these places, and picking Top center here puts it back.',
						visible: bannerShown,
						control: {
							type: 'dropdown',
							key: 'mobileRecordingBannerPosition',
							options: RECORDING_BANNER_ANCHOR_LABELS,
						},
					},
				],
			},
		],
	};
}
