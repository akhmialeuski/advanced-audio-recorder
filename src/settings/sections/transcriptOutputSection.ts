/**
 * Where a finished transcript is written and how each line is formatted.
 * @module settings/sections/transcriptOutputSection
 */

import { effectiveDiarize } from '../../transcription/providers/capabilities';
import {
	TRANSCRIPT_DESTINATION_LABELS,
	TRANSCRIPT_FILE_FORMAT_LABELS,
} from '../labels';
import type { AudioRecorderSettings } from '../settingsSchema';
import { SETTINGS_SECTION_CLASS } from './context';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';

/**
 * Where a finished transcript goes and how it is written. The speaker-related
 * rows are disabled without diarization in effect: they exist, the current
 * engine and settings just produce no speaker labels for them to format.
 * @param settings - Live settings, read by the predicates
 */
export function transcriptOutputGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const diarizes = (): boolean =>
		effectiveDiarize(
			settings.transcriptionProvider,
			settings.transcriptionDiarize,
		);
	const speakerHint =
		'Available only with speaker diarization; the current engine and settings produce no speaker labels.';
	const template = (
		key: string,
		name: string,
		desc: string,
		speakerOnly = false,
	): SettingDefinition => ({
		name,
		desc: speakerOnly && !diarizes() ? speakerHint : desc,
		control: {
			type: 'text',
			key,
			validate: (value: string): string | undefined =>
				value.trim() === '' ? 'A template cannot be empty.' : undefined,
			...(speakerOnly ? { disabled: (): boolean => !diarizes() } : {}),
		},
	});
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Transcript output',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Destination',
				desc: 'Insert into the note, save as a sidecar file, both, or save a file and link it.',
				control: {
					type: 'dropdown',
					key: 'transcriptDestination',
					options: TRANSCRIPT_DESTINATION_LABELS,
				},
			},
			{
				name: 'File format',
				desc: 'Format for the transcript sidecar file.',
				visible: (): boolean =>
					settings.transcriptDestination !== 'note',
				control: {
					type: 'dropdown',
					key: 'transcriptFileFormat',
					options: TRANSCRIPT_FILE_FORMAT_LABELS,
				},
			},
			{
				name: 'Note heading',
				desc: 'Heading inserted above the transcript (empty for none).',
				control: { type: 'text', key: 'transcriptHeading' },
			},
			{
				name: 'Include timestamps',
				control: {
					type: 'toggle',
					key: 'transcriptIncludeTimestamps',
				},
			},
			{
				name: 'Timestamps as player links',
				desc: 'Render each timestamp as a #t= link that jumps the enhanced player.',
				control: { type: 'toggle', key: 'transcriptTimestampLinks' },
			},
			{
				name: 'Include speakers',
				desc: speakerHint,
				control: {
					type: 'toggle',
					key: 'transcriptIncludeSpeakers',
					disabled: (): boolean => !diarizes(),
				},
			},
			{
				name: 'Merge speaker turns',
				desc: 'Combine consecutive segments from the same speaker into one line.',
				control: {
					type: 'toggle',
					key: 'transcriptMergeConsecutiveSpeaker',
					disabled: (): boolean => !diarizes(),
				},
			},
			template(
				'transcriptTimestampFormat',
				'Timestamp format',
				'Template for the timestamp; {time} is the timecode or link.',
			),
			template(
				'transcriptSpeakerFormat',
				'Speaker format',
				'Template for the speaker label; {speaker} is the name.',
				true,
			),
			template(
				'transcriptLineFormat',
				'Line format',
				'Arrangement of {timestamp} {speaker} {text}.',
			),
			{
				name: 'Rename speakers',
				aliases: ['speaker names', 'labels'],
				desc: 'Add a "Rename speakers" action that replaces diarized labels with participant names in an existing transcript.',
				control: {
					type: 'toggle',
					key: 'transcriptionSpeakerRenameEnabled',
				},
			},
		],
	};
}
