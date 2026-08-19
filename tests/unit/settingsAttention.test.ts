/**
 * Tests the predicates behind the status indicator a page entry carries: which
 * engines a vault actually calls, whether each of them could run, and the
 * multi-track state a recording is refused on.
 * @module tests/unit/settingsAttention.test
 */

import {
	engineNeedsSetup,
	engineSetupReason,
	engineStatus,
	enginesInUse,
	enginesStatus,
	multiTrackStatus,
	transcriptionRefusal,
} from 'src/settings/settingsAttention';
import {
	ENGINES,
	ENGINE_IDS,
	missingModelMessage,
} from 'src/providers/providers';
import {
	LOCAL_WHISPER_SETUP_MESSAGE,
	TRANSCRIPTION_PROVIDER_IDS,
} from 'src/constants';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { setPlatform } from '../helpers/platform';

/**
 * Settings for one case, over the shipped defaults.
 * @param overrides - Fields this case cares about
 */
function makeSettings(
	overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('engineNeedsSetup', () => {
	const whisper = ENGINES[ENGINE_IDS.WHISPER_API];
	const local = ENGINES[ENGINE_IDS.LOCAL_WHISPER];

	it('reports an account engine with no key', () => {
		expect(
			engineNeedsSetup(makeSettings({ whisperApiKey: '' }), whisper),
		).toBe(true);
	});

	it('reports an account engine whose catalogue holds no choice', () => {
		expect(
			engineNeedsSetup(
				makeSettings({ whisperApiKey: 'sk-1', whisperApiModel: '' }),
				whisper,
			),
		).toBe(true);
	});

	it('accepts an account engine with both halves', () => {
		expect(
			engineNeedsSetup(makeSettings({ whisperApiKey: 'sk-1' }), whisper),
		).toBe(false);
	});

	it.each([
		['neither path', '', ''],
		['no model file', '/bin/whisper', ''],
		['no binary', '', '/models/base.bin'],
	])('reports the local engine with %s', (_case, binary, model) => {
		expect(
			engineNeedsSetup(
				makeSettings({
					localWhisperBinaryPath: binary,
					localWhisperModelPath: model,
				}),
				local,
			),
		).toBe(true);
	});

	it('accepts the local engine with both paths', () => {
		expect(
			engineNeedsSetup(
				makeSettings({
					localWhisperBinaryPath: '/bin/whisper',
					localWhisperModelPath: '/models/base.bin',
				}),
				local,
			),
		).toBe(false);
	});
});

describe('engineSetupReason', () => {
	// The sentence a run throws, so a caller outside the settings can answer
	// with the reason rather than starting something that cannot work.
	it('names the key an account engine is missing', () => {
		expect(
			engineSetupReason(
				makeSettings({ whisperApiKey: '' }),
				ENGINES[ENGINE_IDS.WHISPER_API],
			),
		).toBe('Set the OpenAI API key in settings.');
	});

	it('names the model a reachable engine has none of', () => {
		expect(
			engineSetupReason(
				makeSettings({ whisperApiKey: 'sk-1', whisperApiModel: '' }),
				ENGINES[ENGINE_IDS.WHISPER_API],
			),
		).toBe(missingModelMessage(ENGINES[ENGINE_IDS.WHISPER_API]));
	});

	it('names both paths the local engine needs', () => {
		expect(
			engineSetupReason(
				makeSettings({ localWhisperBinaryPath: '/bin/whisper' }),
				ENGINES[ENGINE_IDS.LOCAL_WHISPER],
			),
		).toBe(LOCAL_WHISPER_SETUP_MESSAGE);
	});

	it('answers with nothing for an engine that could run', () => {
		expect(
			engineSetupReason(
				makeSettings({ whisperApiKey: 'sk-1' }),
				ENGINES[ENGINE_IDS.WHISPER_API],
			),
		).toBeNull();
	});
});

describe('transcriptionRefusal', () => {
	it('refuses while transcription is switched off', () => {
		expect(
			transcriptionRefusal(
				makeSettings({
					transcriptionEnabled: false,
					whisperApiKey: 'sk-1',
				}),
			),
		).toBe('Transcription is switched off in settings.');
	});

	it('refuses an engine this device cannot run', () => {
		setPlatform({ isMobile: true, isMobileApp: true });

		expect(
			transcriptionRefusal(
				makeSettings({
					transcriptionEnabled: true,
					transcriptionProvider:
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					localWhisperBinaryPath: '/bin/whisper',
					localWhisperModelPath: '/models/base.bin',
				}),
			),
		).toContain('not available on this device');
	});

	it('refuses an engine that is not configured, in its own words', () => {
		expect(
			transcriptionRefusal(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: '',
				}),
			),
		).toBe('Set the OpenAI API key in settings.');
	});

	it('refuses a stored engine no engine claims', () => {
		// data.json is a file a sync conflict or a hand edit can leave holding
		// an id this plugin has no engine for.
		expect(
			transcriptionRefusal(
				makeSettings({
					transcriptionEnabled: true,
					transcriptionProvider:
						'nonesuch' as AudioRecorderSettings['transcriptionProvider'],
				}),
			),
		).toBe(
			'The selected transcription engine is not one this plugin serves.',
		);
	});

	it('answers with nothing where a transcription could run', () => {
		expect(
			transcriptionRefusal(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: 'sk-1',
				}),
			),
		).toBeNull();
	});
});

describe('enginesInUse', () => {
	it('is empty where nothing calls an engine', () => {
		expect(
			enginesInUse(
				makeSettings({
					transcriptionEnabled: false,
					transcriptionAutoChaptersEnabled: false,
				}),
			),
		).toEqual([]);
	});

	it('holds the speech engine transcription is set to', () => {
		expect(
			enginesInUse(makeSettings({ transcriptionEnabled: true })),
		).toEqual([ENGINES[ENGINE_IDS.WHISPER_API]]);
	});

	it('holds a job engine only while that job is switched on', () => {
		const off = enginesInUse(
			makeSettings({
				transcriptionEnabled: true,
				llmPostProcessEnabled: false,
				llmProvider: 'anthropic',
			}),
		);
		const on = enginesInUse(
			makeSettings({
				transcriptionEnabled: true,
				llmPostProcessEnabled: true,
				llmProvider: 'anthropic',
			}),
		);

		expect(off).not.toContain(ENGINES[ENGINE_IDS.ANTHROPIC]);
		expect(on).toContain(ENGINES[ENGINE_IDS.ANTHROPIC]);
	});

	it('names an engine once when two jobs call it', () => {
		const called = enginesInUse(
			makeSettings({
				transcriptionEnabled: true,
				llmPostProcessEnabled: true,
				llmProvider: 'anthropic',
				transcriptionAutoChaptersEnabled: true,
				chaptersLlmProvider: 'anthropic',
			}),
		);

		expect(
			called.filter((engine) => engine === ENGINES[ENGINE_IDS.ANTHROPIC]),
		).toHaveLength(1);
	});

	// Chapters are generated on a transcript that already exists, so the job
	// outlives the switch that transcribes new recordings.
	it('holds the chapters engine with transcription off', () => {
		expect(
			enginesInUse(
				makeSettings({
					transcriptionEnabled: false,
					transcriptionAutoChaptersEnabled: true,
					chaptersLlmProvider: 'gemini',
				}),
			),
		).toEqual([ENGINES[ENGINE_IDS.GEMINI]]);
	});
});

describe('engineStatus', () => {
	it('warns on an engine a job calls that cannot run', () => {
		expect(
			engineStatus(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: '',
				}),
				ENGINES[ENGINE_IDS.WHISPER_API],
			),
		).toBe('warning');
	});

	it('stays quiet on an unconfigured engine nobody calls', () => {
		expect(
			engineStatus(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: 'sk-1',
					deepgramApiKey: '',
				}),
				ENGINES[ENGINE_IDS.DEEPGRAM],
			),
		).toBeNull();
	});

	it('stays quiet on a configured engine', () => {
		expect(
			engineStatus(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: 'sk-1',
				}),
				ENGINES[ENGINE_IDS.WHISPER_API],
			),
		).toBeNull();
	});
});

describe('enginesStatus', () => {
	it('warns when any engine in use cannot run', () => {
		expect(
			enginesStatus(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: 'sk-1',
					llmPostProcessEnabled: true,
					llmProvider: 'anthropic',
					anthropicApiKey: '',
				}),
			),
		).toBe('warning');
	});

	it('stays quiet when every engine in use can run', () => {
		expect(
			enginesStatus(
				makeSettings({
					transcriptionEnabled: true,
					whisperApiKey: 'sk-1',
				}),
			),
		).toBeNull();
	});
});

describe('multiTrackStatus', () => {
	beforeEach(() => {
		setPlatform({ isMobile: false, isMobileApp: false });
	});

	/**
	 * Track sources as a configured section holds them.
	 * @param deviceIds - One device id per track, in order
	 */
	const sources = (
		...deviceIds: string[]
	): AudioRecorderSettings['trackAudioSources'] =>
		new Map(
			deviceIds.map((deviceId, index) => [
				index + 1,
				{ deviceId, channelMode: 'source' as const },
			]),
		);

	it('stays quiet while multi-track is off', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: false,
					maxTracks: 2,
					trackAudioSources: sources(),
				}),
			),
		).toBeNull();
	});

	it('warns where no track has an input, which records nothing', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 2,
					trackAudioSources: sources(),
				}),
			),
		).toBe('warning');
	});

	// Capture opens the tracks that have an input and skips the rest, so a
	// partly configured section records - and an indicator would sit on it
	// permanently.
	it('stays quiet on a track left unassigned below the count', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 3,
					trackAudioSources: sources('mic-1', 'iface-1'),
				}),
			),
		).toBeNull();
	});

	it('stays quiet once every offered track has an input', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 2,
					trackAudioSources: sources('mic-1', 'iface-1'),
				}),
			),
		).toBeNull();
	});

	// A track configured above the count in use is not opened at all.
	it('warns where the only assigned track is beyond the count', () => {
		const configured = sources('mic-1', 'iface-1');
		configured.delete(1);

		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 1,
					trackAudioSources: configured,
				}),
			),
		).toBe('warning');
	});

	// The capture is unavailable there, so the section is not what a failed
	// recording would be about.
	it('stays quiet on a platform without multi-track capture', () => {
		setPlatform({ isMobile: true, isMobileApp: true });

		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 2,
					trackAudioSources: sources(),
				}),
			),
		).toBeNull();
	});
});
