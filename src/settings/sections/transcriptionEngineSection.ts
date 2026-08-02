/**
 * The provider fields no declarative control type covers: the API key, which
 * is a password field, and the local whisper.cpp file paths.
 * @module settings/sections/transcriptionEngineSection
 */

import {
	LOCAL_WHISPER_MODEL_NAMES,
	LOCAL_WHISPER_MODELS_DOC_URL,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { addText, type SettingsSectionContext } from '../settingControls';
import { isProviderAvailableOnPlatform } from '../../transcription/providers/capabilities';
import type { ProviderDescriptor } from '../../providers/providers';

/**
 * A provider's API key: a password field with the reveal toggle Obsidian's own
 * keychain dialog uses, which no declarative control type covers. Rendered from
 * the provider's connection, so the field a key is entered in is the one both
 * its transcription and its post-processing read.
 * @param ctx - The section context (host element and save hooks)
 * @param provider - The provider whose key is being entered
 */
export function renderProviderKeyField(
	ctx: SettingsSectionContext,
	provider: ProviderDescriptor,
): void {
	const connection = provider.connection;
	if (!connection) {
		return;
	}
	const s = ctx.settings;
	const docs = provider.transcription?.models ?? provider.llm?.models;
	addText(ctx, {
		name: connection.keyFieldName,
		desc: connection.keyFieldDesc,
		...(docs
			? { helpLink: { label: docs.docLabel, url: docs.docUrl } }
			: {}),
		get: () => connection.apiKey(s),
		set: (v) => {
			connection.setApiKey(s, v);
		},
		secret: true,
	});
}

/** Local whisper.cpp engine fields (binary path, model path, extra args). */
export function renderLocalWhisperSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	// A stored local-whisper selection synced to a platform that cannot
	// run it (mobile) keeps its fields visible but blocked, so the user
	// sees why transcription will not run instead of editable settings
	// that quietly do nothing.
	const unavailable = !isProviderAvailableOnPlatform(
		TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
	);
	const unavailableHint = unavailable
		? ' Local whisper.cpp is not available on this device; pick a cloud engine to transcribe here.'
		: '';
	addText(ctx, {
		name: 'whisper.cpp binary path',
		desc: `Absolute path to the whisper.cpp executable.${unavailableHint}`,
		get: () => s.localWhisperBinaryPath,
		set: (v) => (s.localWhisperBinaryPath = v),
		disabled: unavailable,
	});
	addText(ctx, {
		name: 'Model path',
		desc: `Absolute path to a GGML model file (.bin). Download one of: ${LOCAL_WHISPER_MODEL_NAMES.join(', ')} (names ending in .en are English-only).`,
		helpLink: {
			label: 'Download whisper.cpp models',
			url: LOCAL_WHISPER_MODELS_DOC_URL,
		},
		get: () => s.localWhisperModelPath,
		set: (v) => (s.localWhisperModelPath = v),
		disabled: unavailable,
	});
	addText(ctx, {
		name: 'Extra arguments',
		desc: 'Optional extra CLI arguments, space-separated.',
		get: () => s.localWhisperExtraArgs,
		set: (v) => (s.localWhisperExtraArgs = v),
		disabled: unavailable,
	});
}
