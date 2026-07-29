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
	addModelPicker,
	addNumberInput,
	addText,
	type SettingsSectionContext,
} from '../settingControls';
import { isProviderAvailableOnPlatform } from '../../transcription/providers/capabilities';
import {
	selectedTranscriptionEngine,
	type EngineCredentials,
} from '../../transcription/providers/engines';

/**
 * The cloud-engine fields: base URL, API key, and model picker, all bound
 * through the selected engine's descriptor. The three cloud engines differ only
 * in their labels and which settings fields they address, both of which the
 * registry owns, so one renderer covers them all.
 * @param ctx - Section context
 */
export function renderCloudEngineSettings(
	ctx: SettingsSectionContext,
	credentials: EngineCredentials,
): void {
	const s = ctx.settings;
	addText(ctx, {
		name: credentials.baseUrlFieldName,
		desc: credentials.baseUrlFieldDesc,
		get: () => credentials.baseUrl(s),
		set: (v) => credentials.setBaseUrl(s, v),
	});
	addText(ctx, {
		name: credentials.keyFieldName,
		desc: credentials.keyFieldDesc,
		get: () => credentials.apiKey(s),
		set: (v) => credentials.setApiKey(s, v),
		secret: true,
	});
	addModelPicker(ctx, {
		name: credentials.modelPickerName,
		desc: credentials.modelPickerDesc,
		helpLink: {
			label: credentials.modelsDocLabel,
			url: credentials.modelsDocUrl,
		},
		getModels: () => credentials.models(s),
		setModels: (models) => credentials.setModels(s, models),
		getSelected: () => selectedTranscriptionEngine(s).model(s),
		setSelected: (id) => credentials.setModel(s, id),
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
