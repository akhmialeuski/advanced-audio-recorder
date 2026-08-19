/**
 * Tests the predicates behind the status indicator a page entry carries: which
 * engines a vault actually calls, whether each of them could run, and the
 * multi-track state a recording is refused on.
 * @module tests/unit/settingsAttention.test
 */

import {
	engineNeedsSetup,
	engineStatus,
	enginesInUse,
	enginesStatus,
	multiTrackStatus,
} from 'src/settings/settingsAttention';
import { ENGINES, ENGINE_IDS } from 'src/providers/providers';
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

	it('warns on a track that has no input', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 2,
					trackAudioSources: sources('mic-1'),
				}),
			),
		).toBe('warning');
	});

	it('warns on a track whose input is blank', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 2,
					trackAudioSources: sources('mic-1', '   '),
				}),
			),
		).toBe('warning');
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

	// A track configured above the count in use is not part of the recording.
	it('ignores tracks beyond the configured count', () => {
		expect(
			multiTrackStatus(
				makeSettings({
					enableMultiTrack: true,
					maxTracks: 1,
					trackAudioSources: sources('mic-1', ''),
				}),
			),
		).toBeNull();
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
