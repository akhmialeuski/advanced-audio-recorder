/**
 * The transcription provider double the pipeline suites drive.
 *
 * Six suites carried the same literal: an unbounded, whole-file-capable
 * engine whose only interesting part is what `transcribe` returns. What each
 * suite actually varies is one field - the engine id, whether it diarizes,
 * what the call resolves with - so the literal lives here and a suite names
 * only its difference.
 * @module tests/helpers/providerFixtures
 */

import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from 'src/transcription/providers/TranscriptionProvider';
import type { WhisperResult } from 'src/transcription/providers/whisperResponse';

/**
 * An engine with no request limits that takes the original container. This is
 * the shape that keeps a test on the whole-file path, where no Web Audio
 * decode is needed and the service issues exactly one request.
 */
export const UNLIMITED_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: Number.POSITIVE_INFINITY,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	supportsDiarization: true,
	supportsDictionary: true,
	wordTimestamps: 'requested',
	biasChannel: 'prompt',
};

/** What a suite varies about the provider it transcribes through. */
export interface FakeProviderOptions {
	/** Engine the provider claims to be; drives the settings-side routing. */
	id?: TranscriptionProviderId;
	/** Capability fields to override, e.g. an engine that cannot diarize. */
	capabilities?: Partial<ProviderCapabilities>;
	/**
	 * What one request resolves with, or the whole implementation when the
	 * test needs to act during the call (cancel mid-flight, fail one part).
	 */
	transcribe?:
		| WhisperResult
		| ((
				payload: AudioPayload,
				options: TranscribeOptions,
		  ) => Promise<WhisperResult>);
}

/** The double, with `transcribe` left as a mock so calls can be asserted. */
export interface FakeProvider extends TranscriptionProvider {
	transcribe: jest.Mock<
		Promise<WhisperResult>,
		[AudioPayload, TranscribeOptions]
	>;
}

/**
 * Builds the provider double.
 *
 * `transcribe` stays a `jest.Mock`, so a test reads the options it was called
 * with off `provider.transcribe.mock.lastCall` rather than through a bespoke
 * `lastOptions` field the double would have to maintain.
 * @param options - The engine id, capability overrides, and what a call returns
 * @returns The provider, ready to hand to the service under test
 */
export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
	const {
		id = TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		capabilities = {},
		transcribe = { segments: [{ start: 0, end: 1, text: 'hi' }] },
	} = options;
	const implementation =
		typeof transcribe === 'function'
			? transcribe
			: (): Promise<WhisperResult> => Promise.resolve(transcribe);
	return {
		id,
		label: 'Fake',
		requiresNetwork: false,
		capabilities: { ...UNLIMITED_CAPABILITIES, ...capabilities },
		transcribe: jest.fn(implementation),
	};
}

/** Capability overrides for an engine that returns no speaker labels. */
export const NO_DIARIZATION: Partial<ProviderCapabilities> = {
	supportsDiarization: false,
	supportsDictionary: false,
	wordTimestamps: 'none',
};
