/**
 * Transcription itself: the engine it runs on, the language it is told, and
 * what it is asked to return.
 * @module settings/sections/transcriptionSection
 */

import {
	MAX_LOCAL_WHISPER_TIMEOUT_MINUTES,
	MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
	MIN_LOCAL_WHISPER_TIMEOUT_MINUTES,
	MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import {
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
	providerSupportsSpeechTranslation,
	wordTimestampsNote,
	wordTimestampsSelectable,
} from '../../transcription/providers/capabilities';
import { TRANSCRIPTION_PROVIDER_LABELS } from '../labels';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from '../settingsSchema';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import type { SettingDefinitionItem, SettingGroupItem } from 'obsidian';

/** Accepted shape of the transcription language field: an ISO code or empty. */
const LANGUAGE_CODE_PATTERN = /^([a-z]{2,3}(-[a-z0-9]{2,8})?|auto)?$/i;

/**
 * Which service transcribes. Only the choice: where that service is reached and
 * which models it serves are configured once, on its own page under Engines.
 * @param settings - Live settings, read by the predicate
 */
function transcriptionEngineRow(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	return {
		// Named for the job it configures rather than "Engine": three rows pick
		// an engine, on three pages, and the settings search lists them by name
		// alone - three results reading "Engine" name nothing.
		name: 'Transcription engine',
		aliases: ['provider', 'whisper', 'deepgram', 'gemini', 'elevenlabs'],
		desc: 'Whisper API, Deepgram, or Google Gemini (cloud), or a local whisper.cpp binary (desktop). Configure each one under Engines.',
		visible: (): boolean => settings.transcriptionEnabled,
		control: {
			type: 'dropdown',
			key: 'transcriptionProvider',
			// Every device lists every engine, so the dropdown reads the same
			// everywhere; picking one this device cannot run is refused with
			// the reason instead of silently blocked.
			options: TRANSCRIPTION_PROVIDER_LABELS,
			validate: (value: string): string | undefined =>
				isProviderAvailableOnPlatform(value as TranscriptionProviderId)
					? undefined
					: 'Not available on this device.',
		},
	};
}

/**
 * The transcription section. Everything below the section's own switch is
 * revealed by a predicate rather than by re-rendering the section, and the
 * options an engine cannot deliver are disabled rather than hidden, so the user
 * can see the option exists and why it is unavailable.
 * @param ctx - Everything the tree reads from the tab
 * @param enginesEntry - The entry opening the page every engine is set up on,
 * placed right under the engine choice it configures
 */
export function transcriptionGroup(
	ctx: SettingsDefinitionContext,
	enginesEntry: SettingGroupItem,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const enabled = (): boolean => settings.transcriptionEnabled;
	const canDiarize = (): boolean =>
		providerSupportsDiarization(settings.transcriptionProvider);
	const canTranslateSpeech = (): boolean =>
		providerSupportsSpeechTranslation(settings.transcriptionProvider);
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Transcription',
		items: [
			{
				name: 'Enable transcription',
				aliases: ['speech to text', 'stt', 'subtitles', 'whisper'],
				desc: 'Transcribe recordings to text, with optional speaker labels and LLM post-processing.',
				control: { type: 'toggle', key: 'transcriptionEnabled' },
			},
			// The first thing to settle once transcription is on, so it opens
			// the block rather than sitting below the run options: which
			// service transcribes, and the page where every service is set up.
			transcriptionEngineRow(settings),
			enginesEntry,
			{
				name: 'Transcribe after recording',
				desc: 'Automatically transcribe each recording once it is saved.',
				visible: enabled,
				control: { type: 'toggle', key: 'transcribeOnSave' },
			},
			{
				name: 'Show cost estimates',
				desc: 'Show an approximate API cost before a run and a running session total (built-in rates; cloud engines only).',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionShowCostEstimates',
				},
			},
			{
				name: 'Language',
				aliases: ['locale', 'spoken language'],
				desc: 'ISO code (e.g. en, ru, es). Leave empty, or write "auto", to detect it.',
				visible: enabled,
				control: {
					type: 'text',
					key: 'transcriptionLanguage',
					placeholder: 'auto',
					validate: (value: string): string | undefined =>
						LANGUAGE_CODE_PATTERN.test(value.trim())
							? undefined
							: 'Use an ISO code such as en or ru, or "auto".',
				},
			},
			{
				name: 'Speaker diarization',
				aliases: ['speakers', 'who spoke', 'diarisation'],
				desc: 'Request speaker labels. Speaker count is detected automatically.',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionDiarize',
					// Kept visible on an engine that cannot diarize: the option
					// exists, this engine just cannot deliver it.
					disabled: (): boolean => !canDiarize(),
				},
			},
			{
				name: 'Translate speech to English',
				aliases: ['translation', 'english'],
				desc: 'Write the recording down in English whatever was spoken, using the engine own translating operation. The language hint above is ignored while this is on.',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionTranslateToEnglish',
					// Kept visible on an engine with no such operation: the
					// option exists, this engine just has nothing to answer it.
					disabled: (): boolean => !canTranslateSpeech(),
				},
			},
			// The rosters a run labels speakers with, beside the switch that
			// asks for the labels.
			...profileCatalogues(ctx, 'transcription'),
			{
				name: 'Word-level timestamps',
				// Read at build time rather than per render, which is enough:
				// picking another engine reshapes the tree (see
				// CONTROL_WRITE_EFFECTS), so this row is built again with it.
				desc: wordTimestampsNote(settings.transcriptionProvider),
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionWordTimestamps',
					// Kept visible on an engine that decides this for itself:
					// the option exists, this engine just does not take it.
					disabled: (): boolean =>
						!wordTimestampsSelectable(
							settings.transcriptionProvider,
						),
				},
			},
			{
				name: 'Request timeout',
				desc: 'Minutes before one transcription request is aborted, so a stalled request cannot hang the run.',
				// Local whisper.cpp runs no HTTP request, so the timeout has
				// nothing to bound there. The run it does make is bounded by
				// the row below, which takes this one's place on that engine.
				visible: (): boolean =>
					enabled() &&
					settings.transcriptionProvider !==
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				control: {
					type: 'number',
					key: 'transcriptionTimeoutMinutes',
					min: MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
					max: MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
					step: 1,
				},
			},
			{
				name: 'Local run timeout',
				aliases: ['whisper.cpp', 'process', 'offline'],
				desc: 'Minutes before the local whisper.cpp process is stopped, so a run that hangs cannot hold the dialog or the CPU. Longer than a network timeout on purpose: the model runs on this machine, and a large one can take longer than the recording itself.',
				// The mirror of the row above: exactly one of the two is shown,
				// because exactly one of them bounds the work this engine does.
				visible: (): boolean =>
					enabled() &&
					settings.transcriptionProvider ===
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				control: {
					type: 'number',
					key: 'localWhisperTimeoutMinutes',
					min: MIN_LOCAL_WHISPER_TIMEOUT_MINUTES,
					max: MAX_LOCAL_WHISPER_TIMEOUT_MINUTES,
					step: 1,
				},
			},
		],
	};
}
