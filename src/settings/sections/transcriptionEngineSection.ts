/**
 * The per-engine transcription settings: the cloud engines' endpoint, key, and
 * model picker (all bound through the selected engine's descriptor) and the
 * local whisper.cpp file paths.
 * @module settings/sections/transcriptionEngineSection
 */

import {
	MIN_TRANSCRIBE_CHUNK_MB,
	MAX_TRANSCRIBE_CHUNK_MB,
	LOCAL_WHISPER_MODEL_NAMES,
	LOCAL_WHISPER_MODELS_DOC_URL,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import {
	addNumberInput,
	addText,
	type SettingsSectionContext,
} from '../settingControls';
import { isProviderAvailableOnPlatform } from '../../transcription/providers/capabilities';
import type { EngineCredentials } from '../../transcription/providers/engines';

/**
 * The one cloud-engine field that is not a declared control: the API key, which
 * is a password field. The endpoint and the model list are declarations bound to
 * the keys the engine's descriptor names.
 * @param ctx - Section context
 * @param credentials - The selected engine's descriptor
 */
export function renderCloudEngineSettings(
	ctx: SettingsSectionContext,
	credentials: EngineCredentials,
): void {
	const s = ctx.settings;
	addText(ctx, {
		name: credentials.keyFieldName,
		desc: credentials.keyFieldDesc,
		helpLink: {
			label: credentials.modelsDocLabel,
			url: credentials.modelsDocUrl,
		},
		get: () => credentials.apiKey(s),
		set: (v) => credentials.setApiKey(s, v),
		secret: true,
	});
}

/**
 * The upload chunk size, offered only for the Whisper API: it is the one engine
 * with a per-request byte ceiling low enough that long recordings are split.
 * @param ctx - Section context
 */
export function renderWhisperChunkSize(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addNumberInput(ctx, {
		name: 'Upload chunk size',
		desc: 'Megabytes per WAV chunk when a recording is too large to upload whole (the API limit is 25 MB). Files under the limit are sent untouched.',
		min: MIN_TRANSCRIBE_CHUNK_MB,
		max: MAX_TRANSCRIBE_CHUNK_MB,
		step: 1,
		get: () => s.transcriptionChunkMb,
		set: (v) => (s.transcriptionChunkMb = v),
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
