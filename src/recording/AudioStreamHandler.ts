/**
 * Audio stream handler for managing MediaStream and device enumeration.
 * @module recording/AudioStreamHandler
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioStreamError } from '../errors';
import { delay } from '../utils/TimeUtils';
import type {
	AudioRecorderSettings,
	TrackProcessingMode,
	TrackSourceKind,
} from '../settings/settingsSchema';
import { captureSystemAudioStream } from './systemAudioSupport';
import {
	channelCountFor,
	normalizeChannelMode,
	type ChannelMode,
} from '../audio/downmix';
import type { RecordingEncoding } from '../audio/AudioCapabilityDetector';
import { offlineEncodeSampleRate } from '../audio/AudioFormatConverter';
import {
	isDeviceSelectionSupported,
	isMultiTrackCaptureSupported,
} from '../platform/capabilities';

export interface TrackAudioSource {
	trackNumber: number;
	deviceId: string;
	/** Channel mode captured atomically with the selected device. */
	channelMode: ChannelMode;
	/**
	 * Level applied to this track at the mix, in decibels. Absent means the
	 * track as captured, which is what every session recorded before the
	 * mixer could place a track was.
	 */
	gainDb?: number;
	/** Where this track sits in the mix, from -1 (left) to 1 (right). */
	pan?: number;
	/**
	 * Browser input processing this track is captured with. Absent means the
	 * session-wide toggles, which is what every track used before the choice
	 * was made per track.
	 */
	processing?: TrackProcessingMode;
	/**
	 * What this track captures from. A system-audio track carries no device
	 * id, so every question asked of the device list has to skip it.
	 */
	kind?: TrackSourceKind;
}

/**
 * One coherent view of the currently enumerated audio inputs and their
 * reported channel limits. `enumerationSucceeded` distinguishes a selected
 * device that is genuinely absent from a platform that could not enumerate
 * devices at all.
 */
export interface AudioInputDeviceSnapshot {
	readonly enumerationSucceeded: boolean;
	readonly devices: readonly MediaDeviceInfo[];
	readonly channelLimits: ReadonlyMap<string, number | null>;
}

/**
 * The browser's device API, or null where this environment has none.
 *
 * `navigator.mediaDevices` is absent outside a secure context - a vault opened
 * over plain HTTP - and in some embedded WebViews. Whether it is there is one
 * question, and every caller asks it here rather than each deciding for itself:
 * the answer used to be a guard in two places and an assumption in a third, and
 * the assumption was in the first row the settings tab renders, so its absence
 * emptied the whole tab.
 * @returns The device API, or null when the environment does not expose it
 */
export function audioDeviceApi(): MediaDevices | null {
	return navigator.mediaDevices ?? null;
}

/**
 * Gets all available audio input devices.
 * @returns Promise resolving to array of audio input devices
 * @throws Error when this environment exposes no device API
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	const api = audioDeviceApi();
	if (!api) {
		throw new Error('This environment exposes no audio device list.');
	}
	const devices = await api.enumerateDevices();
	return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * Maximum capture channel count a device reports, or null when the
 * platform does not expose it. Read from InputDeviceInfo capabilities
 * (available on already-enumerated devices once microphone permission
 * exists), so no stream is opened. Exported for the settings UI, which
 * greys out the channel selectors for known-mono devices.
 * @param device - Enumerated device, or undefined when not found
 * @returns Maximum channels, or null when unknown
 */
export function deviceMaxChannels(
	device: MediaDeviceInfo | undefined,
): number | null {
	if (!device || !('getCapabilities' in device)) {
		return null;
	}
	try {
		const capabilities = (device as InputDeviceInfo).getCapabilities();
		const channelCount = capabilities.channelCount;
		if (typeof channelCount === 'number' && channelCount > 0) {
			return channelCount;
		}
		if (
			channelCount &&
			typeof channelCount === 'object' &&
			typeof channelCount.max === 'number' &&
			channelCount.max > 0
		) {
			return channelCount.max;
		}
		return null;
	} catch {
		// Some engines throw for devices without granted permission
		return null;
	}
}

/**
 * Name fragments that identify an input carrying this machine's own output,
 * lowercased and matched as substrings.
 *
 * Windows publishes such an input as a driver feature (Stereo Mix) or through
 * an installed virtual cable; macOS only ever through one; PulseAudio and
 * PipeWire publish a monitor source for every output without anything being
 * installed. Each fragment below is the distinctive part of a name one of
 * those actually produces, kept long enough not to catch a real microphone:
 * "monitor of " is the PulseAudio prefix, where the bare word "monitor" would
 * also match a display's built-in input.
 *
 * The list is not, and cannot be, exhaustive. Windows translates these names,
 * and a virtual cable can be renamed by whoever installed it, so this answers
 * "worth pointing at" rather than "is a loopback". Nothing is decided from it:
 * see {@link module:settings/sections/multiTrackSection}, where the user still
 * picks the device and its processing.
 */
const LOOPBACK_LABEL_FRAGMENTS: readonly string[] = [
	'stereo mix',
	'what u hear',
	'wave out mix',
	'cable output',
	'voicemeeter out',
	'blackhole',
	'soundflower',
	'loopback audio',
	'monitor of ',
];

/**
 * Whether an enumerated input looks like it carries the system's own output.
 *
 * Answered from the label, which is the only thing the platforms agree on: a
 * loopback input is an ordinary `audioinput` in every respect the device API
 * reports, so nothing else about it distinguishes it from a microphone. An
 * empty label is therefore a real answer of "unknown" rather than a missing
 * one, and it is what every device reports until microphone permission has
 * been granted once.
 * @param label - The enumerated device's label, possibly empty
 * @returns True when the name matches a known loopback input
 */
export function isLoopbackInputLabel(label: string): boolean {
	const normalized = label.toLowerCase();
	return LOOPBACK_LABEL_FRAGMENTS.some((fragment) =>
		normalized.includes(fragment),
	);
}

/**
 * Enumerates audio inputs once and derives every channel limit from that
 * exact device list. The explicit success flag lets consumers distinguish
 * an unplugged device from an enumeration failure.
 * @returns Coherent device/capability snapshot
 */
export async function getAudioInputDeviceSnapshot(): Promise<AudioInputDeviceSnapshot> {
	const limits = new Map<string, number | null>();
	try {
		const devices = await getAudioInputDevices();
		for (const device of devices) {
			limits.set(device.deviceId, deviceMaxChannels(device));
		}
		return {
			enumerationSucceeded: true,
			devices,
			channelLimits: limits,
		};
	} catch {
		return {
			enumerationSucceeded: false,
			devices: [],
			channelLimits: limits,
		};
	}
}

/**
 * Whether the mono channel options make sense for a device: true for
 * known multichannel devices and for unknown capability (disabling on
 * unknown would block the feature exactly on the platforms that need
 * it most). Only a device that positively reports a single capture
 * channel loses the selection - every mono mode would be an identity
 * or a fallback there.
 * @param maxChannels - Maximum channels, or null when unknown
 */
export function channelSelectionAvailable(
	maxChannels: number | null | undefined,
): boolean {
	return maxChannels === null || maxChannels === undefined || maxChannels > 1;
}

/**
 * Maximum number of retry attempts for temporary errors.
 */
const MAX_RETRIES = 2;

/**
 * Delay between retry attempts in milliseconds.
 */
const RETRY_DELAY_MS = 500;

/**
 * Browser audio-processing constraints applied to the input stream.
 */
export interface AudioProcessingConstraints {
	noiseSuppression: boolean;
	echoCancellation: boolean;
	autoGainControl: boolean;
}

/**
 * Reads the audio-processing constraints from settings.
 * @param settings - Plugin settings
 */
export function getProcessingConstraints(
	settings: AudioRecorderSettings,
): AudioProcessingConstraints {
	return {
		noiseSuppression: settings.inputNoiseSuppression,
		echoCancellation: settings.inputEchoCancellation,
		autoGainControl: settings.inputAutoGainControl,
	};
}

/** Every browser filter on: what a microphone in a room wants. */
const VOICE_PROCESSING: AudioProcessingConstraints = {
	noiseSuppression: true,
	echoCancellation: true,
	autoGainControl: true,
};

/** Every browser filter off: what a loopback or line input wants. */
const RAW_PROCESSING: AudioProcessingConstraints = {
	noiseSuppression: false,
	echoCancellation: false,
	autoGainControl: false,
};

/**
 * The processing one track is captured with.
 *
 * A session can hold a microphone and a system-loopback input at once, and
 * the two want opposite treatment: echo cancellation is what makes a room
 * microphone usable, and it is also what suppresses the far end of a call on
 * a loopback input, because to the filter that audio looks like this
 * machine's own speaker output coming back in. One set of constraints for the
 * whole session could only ever be right for one of them.
 * @param mode - The track's own choice, absent for the session-wide toggles
 * @param sessionWide - What those toggles say, from
 *   {@link getProcessingConstraints}
 * @returns The constraints this track's capture is opened with
 */
export function trackProcessingConstraints(
	mode: TrackProcessingMode | undefined,
	sessionWide: AudioProcessingConstraints,
): AudioProcessingConstraints {
	if (mode === 'voice') {
		return VOICE_PROCESSING;
	}
	if (mode === 'raw') {
		return RAW_PROCESSING;
	}
	return sessionWide;
}

/**
 * Gets a MediaStream for the specified audio device.
 * Implements retry logic for temporary access errors.
 * @param deviceId - Optional device ID to use
 * @param sampleRate - Audio sample rate
 * @param processing - Optional audio-processing constraints
 * @returns Promise resolving to MediaStream
 * @throws AudioStreamError if device access fails after all retries
 */
async function getAudioStream(
	deviceId?: string,
	sampleRate?: number,
	processing?: AudioProcessingConstraints,
): Promise<MediaStream> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				audio: {
					...(deviceId ? { deviceId: { exact: deviceId } } : {}),
					...(sampleRate === undefined ? {} : { sampleRate }),
					...(processing
						? {
								noiseSuppression: processing.noiseSuppression,
								echoCancellation: processing.echoCancellation,
								autoGainControl: processing.autoGainControl,
							}
						: {}),
				},
			});
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));

			// Retry only for temporary errors (AbortError indicates interrupted request)
			const isRetryable =
				error instanceof DOMException &&
				(error.name === 'AbortError' ||
					error.name === 'NotReadableError');

			if (isRetryable && attempt < MAX_RETRIES) {
				console.debug(
					`${PLUGIN_LOG_PREFIX} Retry ${String(attempt + 1)}/${String(MAX_RETRIES)} for device access`,
				);
				await delay(RETRY_DELAY_MS);
				continue;
			}

			throw new AudioStreamError(lastError, deviceId);
		}
	}

	throw new AudioStreamError(
		lastError ?? new Error('Max retries exceeded'),
		deviceId,
	);
}

/**
 * Whether the current session records multiple tracks: the setting must
 * be on AND the platform must support multi-device capture. A stored
 * "on" synced from a desktop config silently degrades to a single-track
 * session where multi-track capture is unavailable (mobile).
 * @param settings - Plugin settings
 * @returns True when a multi-track session should be started
 */
export function isMultiTrackSessionEnabled(
	settings: AudioRecorderSettings,
): boolean {
	return settings.enableMultiTrack && isMultiTrackCaptureSupported();
}

/**
 * The device id capture should request for a single-track session, or
 * undefined for the system default microphone. Stored device ids are
 * ignored where device selection is unavailable (mobile): ids are
 * randomized per install, so a configured id could never be satisfied
 * with an `exact` constraint there.
 * @param settings - Plugin settings
 * @returns Device id to request, or undefined for the default device
 */
export function resolveCaptureDeviceId(
	settings: AudioRecorderSettings,
): string | undefined {
	if (!isDeviceSelectionSupported()) {
		return undefined;
	}
	return settings.audioDeviceId || undefined;
}

/**
 * Gets audio streams based on settings configuration.
 * @param settings - Plugin settings
 * @returns Promise resolving to array of MediaStreams
 */
export async function getAudioStreams(
	settings: AudioRecorderSettings,
): Promise<{ streams: MediaStream[]; trackOrder: TrackAudioSource[] }> {
	const processing = getProcessingConstraints(settings);
	if (isMultiTrackSessionEnabled(settings)) {
		const trackOrder = getOrderedTrackSources(settings);
		const streamPromises = trackOrder.map((source) =>
			source.kind === 'system-audio'
				? captureSystemAudioStream()
				: getAudioStream(
						source.deviceId,
						settings.sampleRate,
						trackProcessingConstraints(
							source.processing,
							processing,
						),
					),
		);
		// Settle every request before failing: with Promise.all a single
		// rejected track would abandon the microphones that already opened,
		// leaving them captured (device locked, indicator on) until app
		// restart, because the caller never receives them to stop.
		const results = await Promise.allSettled(streamPromises);
		const opened = results
			.filter(
				(result): result is PromiseFulfilledResult<MediaStream> =>
					result.status === 'fulfilled',
			)
			.map((result) => result.value);
		const failed = results.find(
			(result): result is PromiseRejectedResult =>
				result.status === 'rejected',
		);
		if (failed) {
			stopAllStreams(opened);
			throw failed.reason;
		}
		return { streams: opened, trackOrder };
	}
	const stream = await getAudioStream(
		resolveCaptureDeviceId(settings),
		settings.sampleRate,
		processing,
	);
	return { streams: [stream], trackOrder: [] };
}

/**
 * What a session recorded under these settings will hand the encoder, as far
 * as the settings can say: the requested sample rate, and the layout the
 * finished file will have. A single track has the layout its channel mode
 * gives it; a merged multi-track file takes the widest of its tracks and goes
 * stereo for a panned one, which is the rule the mixer applies. A session
 * writing its tracks separately is described by its widest track too, which
 * is an upper bound rather than a description of any one file; why that is
 * enough is on {@link RecordingEncoding}. The rate is the one an offline
 * encode runs at here, which is the device's own rather than the requested
 * one (see {@link offlineEncodeSampleRate}).
 * @param settings - Plugin settings
 * @param tracks - The session's tracks. A manager passes the ones it opened
 *   streams for, captured before permission was asked, so an edit made while
 *   it was pending cannot describe a different session; the tab reads them
 *   from the settings it is showing.
 * @returns Rate, layout, and whether the tracks are mixed into one file
 */
export function recordingEncodingFor(
	settings: AudioRecorderSettings,
	tracks: readonly TrackAudioSource[] = isMultiTrackSessionEnabled(settings)
		? getOrderedTrackSources(settings)
		: [],
): RecordingEncoding {
	const modes =
		tracks.length > 0
			? tracks.map((source) => source.channelMode)
			: [normalizeChannelMode(settings.recordingChannels)];
	const mergesTracks = settings.outputMode === 'single' && tracks.length > 1;
	const panned = tracks.some((source) => (source.pan ?? 0) !== 0);
	return {
		sampleRate: offlineEncodeSampleRate(settings.sampleRate),
		numberOfChannels:
			mergesTracks && panned
				? 2
				: Math.max(...modes.map((mode) => channelCountFor(mode))),
		mergesTracks,
	};
}

/**
 * Gets ordered track audio sources based on settings.
 */
export function getOrderedTrackSources(
	settings: AudioRecorderSettings,
): TrackAudioSource[] {
	const sources: TrackAudioSource[] = [];
	if (!settings.enableMultiTrack) {
		return sources;
	}
	for (let i = 1; i <= settings.maxTracks; i++) {
		const source = settings.trackAudioSources.get(i);
		const kind = source?.kind ?? 'input-device';
		// A device track is configured by naming a device; a system-audio
		// track is configured by being one, and never carries an id.
		if (source && (kind === 'system-audio' || source.deviceId)) {
			sources.push({
				trackNumber: i,
				deviceId: kind === 'system-audio' ? '' : source.deviceId,
				channelMode: normalizeChannelMode(source.channelMode),
				gainDb: source.gainDb ?? 0,
				pan: source.pan ?? 0,
				processing: source.processing ?? 'global',
				kind,
			});
		}
	}
	return sources;
}

/**
 * The ids of every audio input the system currently lists.
 * @returns The ids, empty when the platform lists no inputs at all
 */
async function availableInputIds(): Promise<Set<string>> {
	return new Set(
		(await getAudioInputDevices()).map((device) => device.deviceId),
	);
}

/**
 * Whether this capture stream names a device the system no longer lists.
 *
 * Conservative on purpose: being wrong here ends a recording that is running
 * perfectly well. A track that names no device says nothing about itself - the
 * system default input reports no id on some platforms - and a stream is only
 * given up on when every device it does name has gone.
 * @param stream - One of the session's capture streams
 * @param available - Ids the system currently lists
 * @returns True when the stream's input is gone
 */
function captureDeviceGone(
	stream: MediaStream,
	available: ReadonlySet<string>,
): boolean {
	const named = stream
		.getTracks()
		.map((track) => track.getSettings().deviceId)
		.filter((deviceId): deviceId is string => Boolean(deviceId));
	return named.length > 0 && named.every((id) => !available.has(id));
}

/**
 * Which of these capture streams name a device the system no longer lists, by
 * their own index.
 *
 * The index is the answer rather than a sentence, because it is the one thing
 * a session can act on: it is the same index the `ended` event of a track
 * reports, so a loss learned from the device list and a loss learned from the
 * track are one fact in one shape.
 *
 * Asked of the streams rather than of the settings, because that index has to
 * address the streams the session is holding and only the streams themselves
 * say which device each of them opened. Reading the configured inputs answered
 * in a second index space - the one the settings describe *now* - and treating
 * the two as one put them out of step the moment the settings were edited
 * mid-session: an index past the end of the session retired a stream it never
 * had, and enough of those retired a session whose inputs were all still
 * capturing.
 *
 * Answering from the streams also reaches the configuration most sessions run
 * in. A session on the system default input has no stored id to look for, so
 * the settings could say nothing about it at all; its track names the device
 * it actually opened like any other.
 * A capture that is not an enumerated input device at all is exempt, named by
 * index for the same reason the answer is. The system output is granted by the
 * host rather than opened from the device list, and such a stream may still
 * report an id of its own: matched against the inputs it is absent from by
 * construction, so the first `devicechange` would retire a track that is
 * recording perfectly well, and a single-track session with it.
 * @param streams - The session's capture streams, in track order
 * @param notFromInputDevice - Indexes the device list cannot answer for
 * @returns Stream indexes whose device is gone, in stream order
 */
export async function missingCaptureIndexes(
	streams: readonly MediaStream[],
	notFromInputDevice: ReadonlySet<number> = new Set(),
): Promise<number[]> {
	const available = await availableInputIds();
	// A list that came back empty is a platform declining to answer, not
	// every input at once going away.
	if (available.size === 0) {
		return [];
	}
	return streams.flatMap((stream, index) =>
		!notFromInputDevice.has(index) && captureDeviceGone(stream, available)
			? [index]
			: [],
	);
}

/**
 * Validates that the configured audio devices are still available, in the
 * words the user reads when a session refuses to start.
 *
 * A question about the settings, asked before any stream exists, and so a
 * different question from {@link missingCaptureIndexes}, which asks about the
 * streams a session is already holding. One answer served both for a while,
 * which read the live settings as a description of a running session - which
 * they stop being the moment they are edited.
 *
 * A no-op where device selection is unavailable (mobile): stored ids are not
 * used for capture there (see {@link resolveCaptureDeviceId}), so their
 * absence - e.g. desktop ids arriving through a synced data.json - must not
 * block recording on the default microphone.
 * @param settings - Plugin settings holding the configured inputs
 * @throws Error naming what is missing, when anything is
 */
export async function validateSelectedDevices(
	settings: AudioRecorderSettings,
): Promise<void> {
	if (!isDeviceSelectionSupported()) {
		return;
	}
	const available = await availableInputIds();
	if (isMultiTrackSessionEnabled(settings)) {
		const missingTracks = getOrderedTrackSources(settings)
			// A system-audio track names no device, so the device list has
			// nothing to say about it; asked anyway, it refuses every start.
			.filter(
				(source) =>
					source.kind !== 'system-audio' &&
					!available.has(source.deviceId),
			)
			.map((source) => source.trackNumber);
		if (missingTracks.length > 0) {
			throw new Error(
				`Selected audio device(s) for track(s) ${missingTracks.join(', ')} are no longer available.`,
			);
		}
		return;
	}
	if (settings.audioDeviceId && !available.has(settings.audioDeviceId)) {
		throw new Error(
			'Selected audio input device is no longer available. Please choose another device in settings.',
		);
	}
}

/**
 * Gets the display name for an audio device.
 * @param deviceId - Device ID to look up
 * @returns Promise resolving to device label or fallback name
 */
export async function getAudioSourceName(deviceId: string): Promise<string> {
	const devices = await getAudioInputDevices();
	const device = devices.find((d) => d.deviceId === deviceId);
	if (!device) {
		return 'UnknownDevice';
	}
	const label = device.label.replace(/[^a-zA-Z0-9]/g, '');
	return label || `Device${deviceId.substring(0, 8)}`;
}

/**
 * Stops all tracks in the given MediaStreams.
 * @param streams - Array of MediaStreams to stop
 */
export function stopAllStreams(streams: MediaStream[]): void {
	for (const stream of streams) {
		for (const track of stream.getTracks()) {
			track.stop();
		}
	}
}

/**
 * Subscribes to the end of every track of every capture stream, which is how
 * the platform reports that an input has gone away: a USB interface pulled
 * out, a Bluetooth headset that dropped its link, an output the operating
 * system switched. The browser ends the track, and until something listens
 * for that the session keeps its status, its clock, and its silent file.
 *
 * The mirror image of {@link stopAllStreams}, and here for the same reason:
 * both walk every track of every stream, and a session that acquires the
 * streams together releases them together.
 * @param streams - The session's capture streams, in track order
 * @param onEnded - Called with the index of the stream whose track ended
 * @returns Takes every subscription back down; safe to call more than once
 */
export function watchStreamEndings(
	streams: readonly MediaStream[],
	onEnded: (streamIndex: number) => void,
): () => void {
	const detach: (() => void)[] = [];
	streams.forEach((stream, index) => {
		for (const track of stream.getTracks()) {
			const handler = (): void => {
				onEnded(index);
			};
			track.addEventListener('ended', handler);
			detach.push(() => {
				track.removeEventListener('ended', handler);
			});
		}
	});
	return () => {
		for (const remove of detach) {
			remove();
		}
		detach.length = 0;
	};
}
