/**
 * The test capture and the system report, both of which report into their own
 * row.
 * @module settings/sections/diagnosticsSection
 */

import type { AudioRecorderSettings } from '../settingsSchema';
import { type DiagnosticsActions, SETTINGS_BLOCK_ROW_CLASS } from './context';
import { sectionItems } from './rowHelpers';
import type { Setting, SettingGroupItem } from 'obsidian';

/**
 * The diagnostics section: a test capture, the system-information dialog, and
 * the debug switch. Behind an entry of its own, since it is opened when
 * something is wrong rather than while a recording is being set up, and its
 * entry reports the one state it holds.
 * @param diagnostics - Handlers for the two action rows
 * @param settings - Live settings, read by the entry's value
 */
export function diagnosticsPage(
	diagnostics: DiagnosticsActions,
	settings: AudioRecorderSettings,
): SettingGroupItem {
	return {
		type: 'page',
		name: 'Diagnostics',
		desc: 'A test capture, the system report, and verbose logging.',
		displayValue: (): string => (settings.debug ? 'Debug on' : 'Debug off'),
		items: sectionItems([
			{
				name: 'Test recording',
				aliases: ['microphone test', 'check mic'],
				desc: 'Records a 5-second test clip using your current settings and plays it back. Nothing is saved to your vault.',
				// A render row: the capture reports progress into the row and
				// leaves a playback element behind, which no control type covers.
				render: (setting: Setting): (() => void) => {
					setting.settingEl.addClass(SETTINGS_BLOCK_ROW_CLASS);
					setting.addButton((button) =>
						button.setButtonText('Start test').onClick(() => {
							diagnostics.startTestRecording(setting.settingEl);
						}),
					);
					// Handed to whoever renders the row - the framework on 1.13,
					// the legacy renderer below it - and run before the row is
					// rendered again or dropped, so a finished capture never
					// keeps its playback element and blob URL alive detached.
					return (): void => {
						diagnostics.releaseTestRecording();
					};
				},
			},
			{
				name: 'System info',
				aliases: ['diagnostics', 'support', 'report'],
				desc: 'Show full system diagnostics including plugin settings, audio devices, and browser capabilities.',
				action: (): void => {
					diagnostics.showSystemInfo();
				},
			},
			{
				name: 'Debug mode',
				aliases: ['logs', 'logging', 'verbose'],
				desc: 'Enable verbose logs for troubleshooting recording issues.',
				control: { type: 'toggle', key: 'debug' },
			},
		]),
	};
}
