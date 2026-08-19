/**
 * What the settings, as they stand, would stop a run on.
 *
 * From 1.13.1 a page's entry can carry a status indicator beside the value it
 * reports, and the framework's rule for it is narrow: the indicator says only
 * that there is something on the page worth opening, while the explanation
 * stays on the page it leads to. What counts as something is the question this
 * module answers.
 *
 * It answers it in one place because the same state has to be reported by every
 * entry on the way in. A vault whose transcription engine has no key must say
 * so on Transcription, on Engines under it, and on that engine's own page: an
 * indicator on the first of them and nothing on the second sends the user down
 * a trail that goes cold one row in.
 *
 * Only states a run would fail on are reported. "This could be configured
 * further" would be on permanently, and an indicator that is always on says
 * nothing.
 * @module settings/settingsAttention
 */

import {
	accountOf,
	engineOfTranscription,
	engineOfVendor,
	missingModelMessage,
	type EngineDescriptor,
} from '../providers/providers';
import { LOCAL_WHISPER_SETUP_MESSAGE } from '../constants';
import { isProviderAvailableOnPlatform } from '../transcription/providers/capabilities';
import {
	getOrderedTrackSources,
	isMultiTrackSessionEnabled,
} from '../recording/AudioStreamHandler';
import type { AudioRecorderSettings, LlmProviderId } from './settingsSchema';

/**
 * A page entry's status: the indicator, or nothing. The union is the
 * framework's own (`SettingDefinitionPage.status`), named here because the
 * predicates below are the only writers of it.
 */
export type PageStatus = 'warning' | null;

/**
 * Why a run calling this engine would be refused, or null when none would be.
 *
 * The halves are the ones the factories refuse on, and the sentence is the one
 * they throw: an engine reached over an account needs that account's key and
 * one model id out of its catalogue, and the local engine needs both of its
 * paths - a binary with no model file is as unrunnable as no binary at all.
 * Saying it in the engine's own words is what lets a caller outside the
 * settings - the command line - answer with the reason instead of starting
 * something that cannot work.
 * @param settings - Live settings, read for this engine's fields
 * @param engine - The engine being asked about
 * @returns The refusal, or null where the engine is ready
 */
export function engineSetupReason(
	settings: AudioRecorderSettings,
	engine: EngineDescriptor,
): string | null {
	const account = accountOf(engine);
	if (!account) {
		return settings.localWhisperBinaryPath === '' ||
			settings.localWhisperModelPath === ''
			? LOCAL_WHISPER_SETUP_MESSAGE
			: null;
	}
	if (account.apiKey(settings) === '') {
		return account.missingKeyMessage;
	}
	return engine.models !== null && engine.models.model(settings) === ''
		? missingModelMessage(engine)
		: null;
}

/**
 * Whether an engine is missing part of what a run needs from it.
 * @param settings - Live settings, read for this engine's fields
 * @param engine - The engine being asked about
 * @returns Whether a run calling it now would be refused
 */
export function engineNeedsSetup(
	settings: AudioRecorderSettings,
	engine: EngineDescriptor,
): boolean {
	return engineSetupReason(settings, engine) !== null;
}

/**
 * The engines this vault actually calls, as its jobs stand.
 *
 * A job that is switched off calls nothing, and an engine nobody calls is not
 * misconfigured by holding no key - most vaults will never enter one for the
 * three services they do not use. So the question is asked per job, from the
 * same fields the runs read.
 * @param settings - Live settings, read for each job's switch and engine
 * @returns Each engine some enabled job would call, without repeats
 */
export function enginesInUse(
	settings: AudioRecorderSettings,
): EngineDescriptor[] {
	const called: EngineDescriptor[] = [];
	if (settings.transcriptionEnabled) {
		const speech = engineOfTranscription(settings.transcriptionProvider);
		if (speech) {
			called.push(speech);
		}
	}
	const jobs: Array<[boolean, LlmProviderId]> = [
		[
			settings.transcriptionEnabled && settings.llmPostProcessEnabled,
			settings.llmProvider,
		],
		[
			settings.transcriptionEnabled &&
				settings.transcriptionAdvancedEnabled,
			settings.advancedLlmProvider,
		],
		[
			settings.transcriptionAutoChaptersEnabled,
			settings.chaptersLlmProvider,
		],
	];
	for (const [enabled, vendorId] of jobs) {
		if (!enabled) {
			continue;
		}
		const engine = engineOfVendor(vendorId);
		if (engine && !called.includes(engine)) {
			called.push(engine);
		}
	}
	return called;
}

/**
 * The status of one engine's own page: set only for an engine some enabled job
 * calls, because an unused engine holding no key is a vault that never uses it
 * rather than one with something to fix.
 * @param settings - Live settings
 * @param engine - The engine whose page is being declared
 */
export function engineStatus(
	settings: AudioRecorderSettings,
	engine: EngineDescriptor,
): PageStatus {
	return enginesInUse(settings).includes(engine) &&
		engineNeedsSetup(settings, engine)
		? 'warning'
		: null;
}

/**
 * The status of the entries that lead to the engines: the Engines page, and the
 * Transcription page above it. Both report the same thing, because every engine
 * a job calls is configured under both of them, and an indicator that stops at
 * the first row is one the user cannot follow.
 * @param settings - Live settings
 */
export function enginesStatus(settings: AudioRecorderSettings): PageStatus {
	return enginesInUse(settings).some((engine) =>
		engineNeedsSetup(settings, engine),
	)
		? 'warning'
		: null;
}

/**
 * The status of the multi-track page: set where the capture is switched on and
 * no track has an input, which is a session that would open no microphone and
 * record nothing.
 *
 * A track left unassigned below that is not reported. Capture asks
 * {@link getOrderedTrackSources} which tracks to open and it skips the empty
 * ones, so three configured tracks with two devices record two tracks - a
 * working session, and one an indicator would sit on permanently. The question
 * is asked through that same function rather than by walking the slots again,
 * so what the entry warns about cannot drift from what a recording does.
 * @param settings - Live settings
 */
export function multiTrackStatus(settings: AudioRecorderSettings): PageStatus {
	// The same two questions capture asks, in the same order: is this a
	// multi-track session at all - the switch, and a platform that has the
	// capture - and then which tracks it would open.
	if (!isMultiTrackSessionEnabled(settings)) {
		return null;
	}
	return getOrderedTrackSources(settings).length === 0 ? 'warning' : null;
}

/**
 * Why a transcription started now would be refused, or null when none would be.
 *
 * The three answers a run gives before it reaches an engine: the feature is
 * off, the engine cannot run on this device, or it is not configured. Asked by
 * the surfaces that start a transcription without a user in front of them, so
 * that a job which cannot work is refused with its reason rather than started.
 * @param settings - Live settings
 * @returns The refusal, or null where a transcription could run
 */
export function transcriptionRefusal(
	settings: AudioRecorderSettings,
): string | null {
	if (!settings.transcriptionEnabled) {
		return 'Transcription is switched off in settings.';
	}
	if (!isProviderAvailableOnPlatform(settings.transcriptionProvider)) {
		return 'The selected transcription engine is not available on this device. Pick a cloud engine in settings.';
	}
	const engine = engineOfTranscription(settings.transcriptionProvider);
	if (!engine) {
		return 'The selected transcription engine is not one this plugin serves.';
	}
	return engineSetupReason(settings, engine);
}
