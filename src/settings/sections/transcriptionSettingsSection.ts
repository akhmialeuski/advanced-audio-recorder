/**
 * The transcription settings that are still rendered imperatively: the engine's
 * own fields, the advanced two-pass mode, transcript output and formatting, and
 * auto chapters. The parts with
 * their own subject matter live next to this file - the per-engine fields in
 * `transcriptionEngineSection`, the LLM vendor fields in `llmSettingsSection`,
 * and the dictionary and chapter-guidance managers in `profileManagerSection` -
 * so each stays readable instead of one 800-line module.
 *
 * Built from the reusable controls in `settingControls`, so the section stays
 * declarative and free of repeated save wiring.
 * @module settings/sections/transcriptionSettingsSection
 */

import {
	MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
	MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
	ADVANCED_SECOND_PASS_RATIO_STEP,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { selectedTranscriptionEngine } from '../../transcription/providers/engines';
import {
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
} from '../labels';
import {
	addDropdown,
	addHeading,
	addNumberInput,
	addText,
	addToggle,
	type SettingsSectionContext,
} from '../settingControls';
import { effectiveDiarize } from '../../transcription/providers/capabilities';
import {
	renderChapterPromptProfiles,
	renderDictionaryProfiles,
} from './profileManagerSection';
import {
	renderCloudEngineSettings,
	renderLocalWhisperSettings,
	renderWhisperChunkSize,
} from './transcriptionEngineSection';
import { renderLlmSection } from './llmSettingsSection';

/**
 * Renders the transcription settings that are not definitions yet: the engine's
 * own fields, the advanced two-pass mode, the transcript output, auto chapters,
 * and the LLM post-processing. The section's own switch, engine choice, and
 * recognition options live in the definition tree; this runs inside the row
 * that tree keeps for them, so the order the user knows is unchanged.
 * @param ctx - Section context (container, settings, save hooks)
 */
export function renderTranscriptionRemainder(
	ctx: SettingsSectionContext,
): void {
	const s = ctx.settings;
	if (!s.transcriptionEnabled) {
		return;
	}

	// The chunk size precedes the engine's own fields, matching the order the
	// Whisper API section has always had.
	if (s.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.WHISPER_API) {
		renderWhisperChunkSize(ctx);
	}
	// A cloud engine renders base URL, key, and model picker from its
	// descriptor; the local engine has file paths instead of credentials.
	const credentials = selectedTranscriptionEngine(s).credentials;
	if (credentials) {
		renderCloudEngineSettings(ctx, credentials);
	} else {
		renderLocalWhisperSettings(ctx);
	}

	renderAdvancedSection(ctx);
	renderTranscriptOutputSection(ctx);
	renderAutoChaptersSection(ctx);
	renderLlmSection(ctx);
}

/**
 * The advanced transcription settings: a master switch that, when on, reveals
 * the dictionary term biasing and the two-pass mode beneath it. Off by default,
 * so a plain run needs no term biasing; turning it on surfaces the dictionary
 * profiles (the shared term set) first and then the two-pass toggle that reuses
 * those terms. Mirrors the per-run nesting in the Transcribe dialog.
 * @param ctx - Section context
 */
function renderAdvancedSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Advanced');
	addToggle(ctx, {
		name: 'Advanced settings',
		desc:
			'Reveal the dictionary term biasing and the experimental two-pass ' +
			'mode below. Off by default: with it off, a recording transcribes ' +
			'in a single plain pass with no term biasing.',
		get: () => s.transcriptionAdvancedSettingsEnabled,
		set: (v) => (s.transcriptionAdvancedSettingsEnabled = v),
		// Re-render so the dictionary and two-pass sub-sections appear or hide
		// in step with the master switch.
		rerender: true,
	});
	if (!s.transcriptionAdvancedSettingsEnabled) {
		return;
	}
	renderDictionaryProfiles(ctx);
	renderAdvancedTwoPassSection(ctx);
}

/**
 * The advanced two-pass transcription mode (LLM-driven context biasing, after
 * "Whisper: Courtside Edition"): off by default, with the cost trade-off
 * spelled out in the master toggle's description. It is the advanced mode of
 * the same dictionary-biasing feature - it reuses the Dictionary terms picked
 * above as its context candidates rather than a second glossary. The only
 * sub-field (the length safeguard) renders while the mode is on, mirroring the
 * other gated sections. The agents run on the LLM provider configured in the
 * LLM post-processing section, whose fields stay visible while this mode
 * needs them (see {@link renderLlmSection}).
 * @param ctx - Section context
 */
function renderAdvancedTwoPassSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Advanced two-pass transcription');

	addToggle(ctx, {
		name: 'Advanced two-pass transcription (experimental)',
		desc:
			'The advanced mode of dictionary biasing: transcribes each recording ' +
			'twice. LLM agents mine the first draft for the proper names, jargon, ' +
			'and English terms and acronyms, reusing your selected Dictionary ' +
			'terms as candidates, and the second pass re-decodes the audio biased ' +
			'toward them. Warning: roughly 2x the engine cost and time, plus ' +
			'several LLM calls per file. Best for e.g. Russian meetings dense ' +
			'with English terminology (Kubernetes, CI/CD); for everyday ' +
			'recordings keep this off and use the normal single pass.',
		get: () => s.transcriptionAdvancedEnabled,
		set: (v) => (s.transcriptionAdvancedEnabled = v),
		// Re-render so the sub-field below and the LLM provider fields appear
		// or hide in step with the mode.
		rerender: true,
	});
	if (!s.transcriptionAdvancedEnabled) {
		return;
	}

	addNumberInput(ctx, {
		name: 'Second-pass length safeguard',
		desc:
			'Keep the second pass only when its text is at least this fraction ' +
			'of the first pass. A biased decode that came back shorter lost ' +
			'content, so the run falls back to the first-pass transcript.',
		min: MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
		max: MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
		step: ADVANCED_SECOND_PASS_RATIO_STEP,
		get: () => s.advancedSecondPassMinRatio,
		set: (v) => (s.advancedSecondPassMinRatio = v),
	});
}

/**
 * LLM-generated chapters. The feature toggle offers the per-file action
 * and command; the sub-toggle also runs it automatically after each
 * transcription. Both paths use the LLM provider configured in the LLM
 * post-processing section, whose provider fields are revealed whenever
 * either feature needs them.
 * @param ctx - Section context
 */
function renderAutoChaptersSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Auto chapters');

	addToggle(ctx, {
		name: 'Auto chapters',
		desc: 'Add a "Generate chapters from transcript" action that asks the LLM (configured below) to divide a transcribed recording into titled chapters, shown in the enhanced player.',
		get: () => s.transcriptionAutoChaptersEnabled,
		set: (v) => (s.transcriptionAutoChaptersEnabled = v),
		// Re-render so the sub-toggle and the LLM provider fields below
		// appear or hide in step with the feature.
		rerender: true,
	});
	if (!s.transcriptionAutoChaptersEnabled) {
		return;
	}
	addToggle(ctx, {
		name: 'Generate after transcription',
		desc: 'Automatically generate chapters each time a recording is transcribed.',
		get: () => s.transcriptionAutoChaptersOnTranscribe,
		set: (v) => (s.transcriptionAutoChaptersOnTranscribe = v),
	});
	renderChapterPromptProfiles(ctx);
}

/** Transcript output destination and in-note formatting. */
function renderTranscriptOutputSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Transcript output');

	// Speaker labels only exist when diarization is actually in effect (the
	// engine can diarize AND the user enabled it), so the speaker-related
	// output controls are inert without it. Disable and dim them, like the
	// Speaker diarization toggle, so they read as unavailable rather than as
	// settings that quietly do nothing.
	const diarizes = effectiveDiarize(
		s.transcriptionProvider,
		s.transcriptionDiarize,
	);
	const speakerDisabledHint =
		'Available only with speaker diarization; the current engine and settings produce no speaker labels.';

	addDropdown(ctx, {
		name: 'Destination',
		desc: 'Insert into the note, save as a sidecar file, both, or save a file and link it in the note.',
		options: TRANSCRIPT_DESTINATION_OPTIONS,
		get: () => s.transcriptDestination,
		set: (v) =>
			(s.transcriptDestination = v as typeof s.transcriptDestination),
		rerender: true,
	});

	if (s.transcriptDestination !== 'note') {
		addDropdown(ctx, {
			name: 'File format',
			desc: 'Format for the transcript sidecar file.',
			options: TRANSCRIPT_FILE_FORMAT_OPTIONS,
			get: () => s.transcriptFileFormat,
			set: (v) =>
				(s.transcriptFileFormat = v as typeof s.transcriptFileFormat),
		});
	}

	addText(ctx, {
		name: 'Note heading',
		desc: 'Heading inserted above the transcript (empty for none).',
		get: () => s.transcriptHeading,
		set: (v) => (s.transcriptHeading = v),
	});

	addToggle(ctx, {
		name: 'Include timestamps',
		get: () => s.transcriptIncludeTimestamps,
		set: (v) => (s.transcriptIncludeTimestamps = v),
	});

	addToggle(ctx, {
		name: 'Timestamps as player links',
		desc: 'Render each timestamp as a #t= link that jumps the enhanced player.',
		get: () => s.transcriptTimestampLinks,
		set: (v) => (s.transcriptTimestampLinks = v),
	});

	addToggle(ctx, {
		name: 'Include speakers',
		desc: diarizes ? undefined : speakerDisabledHint,
		get: () => s.transcriptIncludeSpeakers,
		set: (v) => (s.transcriptIncludeSpeakers = v),
		disabled: !diarizes,
	});

	addToggle(ctx, {
		name: 'Merge speaker turns',
		desc: diarizes
			? 'Combine consecutive segments from the same speaker into one line (diarized transcripts only).'
			: speakerDisabledHint,
		get: () => s.transcriptMergeConsecutiveSpeaker,
		set: (v) => (s.transcriptMergeConsecutiveSpeaker = v),
		disabled: !diarizes,
	});

	addText(ctx, {
		name: 'Timestamp format',
		desc: 'Template for the timestamp; {time} is the timecode/link. Avoid wrapping {time} in [ ] when timestamp links are on.',
		get: () => s.transcriptTimestampFormat,
		set: (v) => (s.transcriptTimestampFormat = v || '{time}'),
	});
	addText(ctx, {
		name: 'Speaker format',
		desc: diarizes
			? 'Template for the speaker label; {speaker} is the name.'
			: speakerDisabledHint,
		get: () => s.transcriptSpeakerFormat,
		set: (v) => (s.transcriptSpeakerFormat = v || '**{speaker}**'),
		disabled: !diarizes,
	});
	addText(ctx, {
		name: 'Line format',
		desc: 'Arrangement of {timestamp} {speaker} {text}.',
		get: () => s.transcriptLineFormat,
		set: (v) =>
			(s.transcriptLineFormat = v || '{timestamp} {speaker} {text}'),
	});
	// Not gated on diarization: renaming acts on transcripts that already
	// exist, including recordings transcribed before the engine changed.
	// Participant profiles are created and filled from the dialog, so no
	// roster field lives here.
	addToggle(ctx, {
		name: 'Rename speakers',
		desc: 'Add a "Rename speakers" action to replace diarized labels (Speaker 1) with participant names in an existing transcript.',
		get: () => s.transcriptionSpeakerRenameEnabled,
		set: (v) => (s.transcriptionSpeakerRenameEnabled = v),
	});
}
