/**
 * Audio stream handler for managing MediaStream and device enumeration.
 * @module recording/AudioStreamHandler
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioStreamError } from '../errors';
import { delay } from '../utils/TimeUtils';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	TrackProcessingMode,
	TrackSourceKind,
} from '../settings/settingsSchema';
import { OutputMode } from '../types';
import { captureSystemAudioStream } from './systemAudioSupport';
import {
	ChannelMode,
	channelCountFor,
	normalizeChannelMode,
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

/** Suffix marking an input that carries this machine's own output. */
const LOOPBACK_LABEL_SUFFIX = ' (system audio)';

/** Characters of a device id that stand in for a name it has not got. */
const UNNAMED_DEVICE_ID_CHARS = 8;

/**
 * How one enumerated input is named wherever a user picks one.
 *
 * A device with no label has not been through a permission grant yet, and is
 * named by the leading characters of its id so the rows stay distinguishable.
 * A loopback input is marked, because it is the one a user recording a call
 * has to find and its own name rarely says what it does.
 *
 * Answered here rather than at each dropdown: the plugin offers the input
 * list in two places, and a marker that appears in one of them is worse than
 * none, since its absence then reads as "this one is not a loopback".
 * @param device - One enumerated input
 * @returns The label shown for that device
 */
export function deviceOptionLabel(device: MediaDeviceInfo): string {
	const named =
		device.label ||
		`Audio device ${device.deviceId.substring(0, UNNAMED_DEVICE_ID_CHARS)}`;
	return isLoopbackInputLabel(device.label)
		? `${named}${LOOPBACK_LABEL_SUFFIX}`
		: named;
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

/**
 * Every browser filter on: what a microphone in a room wants.
 *
 * Frozen because it is handed to the caller rather than copied for it, as
 * {@link getProcessingConstraints} builds one per call. A profile is the
 * capture policy of every later track in the process, so an edit made to a
 * returned object would follow the plugin to the end of the session.
 */
const VOICE_PROCESSING: Readonly<AudioProcessingConstraints> = Object.freeze({
	noiseSuppression: true,
	echoCancellation: true,
	autoGainControl: true,
});

/** Every browser filter off: what a loopback or line input wants. */
const RAW_PROCESSING: Readonly<AudioProcessingConstraints> = Object.freeze({
	noiseSuppression: false,
	echoCancellation: false,
	autoGainControl: false,
});

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
 * @returns The constraints this track's capture is opened with, which for a
 *   named profile is the shared frozen one rather than a copy of it
 */
export function trackProcessingConstraints(
	mode: TrackProcessingMode | undefined,
	sessionWide: AudioProcessingConstraints,
): Readonly<AudioProcessingConstraints> {
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
 * Whether the multi-track page's own configuration is what this session
 * records: the setting must be on AND the platform must support
 * multi-device capture. A stored "on" synced from a desktop config silently
 * degrades to a single-track session where multi-track capture is
 * unavailable (mobile).
 *
 * A session can hold several tracks without this being true - the pairing of
 * {@link isSystemAudioPairingEnabled} is one - so a caller asking which
 * tracks to open asks {@link getOrderedTrackSources} rather than this.
 * @param settings - Plugin settings
 * @returns True when the per-track configuration is in force
 */
export function isMultiTrackSessionEnabled(
	settings: AudioRecorderSettings,
): boolean {
	return settings.enableMultiTrack && isMultiTrackCaptureSupported();
}

/**
 * Whether this session records the system output beside the microphone
 * without a track having been configured for it.
 *
 * Three facts decide it. The switch, which is the whole of the pairing's
 * configuration. The multi-track switch being *off*, because a per-track
 * configuration already says what each track records, and a session can
 * capture the system output once: adding a track to one that already asks for
 * it would refuse the very sessions the pairing exists to make easy. And the
 * platform, because the pairing opens two captures at once, which is the same
 * ability the multi-track page needs and the mobile app does not have - a
 * switch synced from a desktop config degrades there to the single-track
 * session it always was, exactly as the multi-track one does.
 *
 * Whether the host can actually grant the system output is deliberately not
 * among them. That answer costs a synchronous trip through Electron's remote
 * module, and this question is asked on every settings render as well as at
 * the start of a recording; where the grant is refused, the capture says so in
 * the words the user acts on, which is what a hand-configured system-audio
 * track does too.
 * @param settings - Plugin settings
 * @returns True when the session pairs the microphone with the system output
 */
export function isSystemAudioPairingEnabled(
	settings: AudioRecorderSettings,
): boolean {
	return (
		settings.includeSystemAudio &&
		!settings.enableMultiTrack &&
		isMultiTrackCaptureSupported()
	);
}

/**
 * Whether this session's captures are described by a track list at all.
 *
 * Two configurations produce one: the multi-track page's, and the pairing
 * that stands in for it. Asked as one question wherever the answer decides
 * between the track path and the single capture, so a third way of reaching
 * that path cannot be added to one caller and missed by the other. The one
 * fork that stays on {@link isMultiTrackSessionEnabled} is
 * {@link validateSelectedDevices}, which chooses a sentence rather than a
 * path, and says why there.
 *
 * A multi-track session with no track configured answers true and opens
 * nothing, which is the session the settings entry warns about rather than
 * one this function quietly turns into a recording of the default microphone.
 * @param settings - Plugin settings
 * @returns True when the session opens the tracks a list names
 */
export function isTrackListSession(settings: AudioRecorderSettings): boolean {
	return (
		isMultiTrackSessionEnabled(settings) ||
		isSystemAudioPairingEnabled(settings)
	);
}

/**
 * The output mode a session started under these settings writes in.
 *
 * The stored mode is the multi-track page's, set beside the tracks it
 * describes. The pairing configures no tracks and shows no such row, and the
 * file it exists to produce is one recording of a call rather than a
 * microphone file and a loudspeaker file, so it is mixed whatever the page was
 * last left on.
 * @param settings - Plugin settings
 * @returns The mode this session's tracks are written with
 */
export function effectiveOutputMode(
	settings: AudioRecorderSettings,
): OutputMode {
	return isSystemAudioPairingEnabled(settings)
		? OutputMode.Single
		: settings.outputMode;
}

/**
 * Whether the mixer brings this session's tracks to a common level before it
 * combines them.
 *
 * The same question as {@link effectiveOutputMode}, asked of the switch beside
 * that row: Match track levels is declared on the multi-track page, under a
 * visible predicate that hides it while multi-track is off, so the pairing can
 * neither show it nor be configured through it. A stored value left behind by
 * an earlier multi-track session would otherwise keep correcting the levels of
 * a call nothing on screen says is being corrected, and the pairing's own
 * documentation sends a user who wants that correction to the multi-track page
 * to get it.
 *
 * Every value the multi-track page owns is answered here rather than read off
 * the settings at the point of use, so a row added to that page arrives with
 * one place to say what the pairing does with it.
 * @param settings - Plugin settings
 * @returns True when the mixer levels the tracks against each other
 */
export function effectiveTrackLevelAlignment(
	settings: AudioRecorderSettings,
): boolean {
	return (
		!isSystemAudioPairingEnabled(settings) && settings.mixAlignTrackLevels
	);
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
 * @returns The opened streams and, for a multi-track session, the tracks
 *   they were opened for, in the same order
 * @throws Error naming the tracks to change, where the session asks for the
 *   system output more than once. A configuration the user fixes in
 *   settings, reported the way validateSelectedDevices reports one: thrown
 *   plain, so describeRecordingError prints the message unchanged after its
 *   own "Error starting recording:" head rather than replacing that head
 *   with a device failure
 * @throws AudioStreamError where opening a track's capture failed
 */
export async function getAudioStreams(
	settings: AudioRecorderSettings,
): Promise<{ streams: MediaStream[]; trackOrder: TrackAudioSource[] }> {
	const processing = getProcessingConstraints(settings);
	if (isTrackListSession(settings)) {
		const trackOrder = getOrderedTrackSources(settings);
		const surplus = surplusSystemAudioTracks(trackOrder);
		if (surplus.length > 0) {
			// Refused before anything is opened rather than left to fail
			// halfway: the two grants would ask the host at the same time and
			// take each other's handler back down, so one of them is answered
			// with a refusal and the session dies seconds in. Even when the
			// timing spares them, the reward is the same audio twice, at twice
			// its level against the microphone beside it.
			throw new Error(
				`Track(s) ${surplus.join(', ')} also record the system audio, ` +
					'which one session can capture only once. Set them to an ' +
					'input device, or lower the track count.',
			);
		}
		const streamPromises = trackOrder.map((source) =>
			source.kind === TrackSourceKind.SystemAudio
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
	tracks: readonly TrackAudioSource[] = isTrackListSession(settings)
		? getOrderedTrackSources(settings)
		: [],
): RecordingEncoding {
	const modes =
		tracks.length > 0
			? tracks.map((source) => source.channelMode)
			: [normalizeChannelMode(settings.recordingChannels)];
	const mergesTracks =
		effectiveOutputMode(settings) === OutputMode.Single &&
		tracks.length > 1;
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
 * The two tracks the system-audio pairing records, in capture order.
 *
 * Neither is stored anywhere. The microphone track is the single-track
 * session as it stands - the input the device row names, the layout the
 * channel row picks, the filters the processing switches apply - so turning
 * the pairing on changes nothing about the recording that was already being
 * made; it adds the second track beside it. That second one is a system-audio
 * track, which is configured by being one.
 * @param settings - Plugin settings, read for the single-track capture
 * @returns The microphone track, then the system output
 */
function systemAudioPairSources(
	settings: AudioRecorderSettings,
): TrackAudioSource[] {
	return [
		{
			trackNumber: 1,
			// Asked the way the single-track path asks it, so a stored id the
			// platform cannot satisfy is left behind here too.
			deviceId: resolveCaptureDeviceId(settings) ?? '',
			channelMode: normalizeChannelMode(settings.recordingChannels),
			gainDb: 0,
			pan: 0,
			processing: TrackProcessingMode.Global,
			kind: TrackSourceKind.InputDevice,
		},
		{
			trackNumber: 2,
			deviceId: '',
			channelMode: ChannelMode.Source,
			gainDb: 0,
			pan: 0,
			// No processing named: this capture is granted by the host rather
			// than opened through getUserMedia, so none of those filters is on
			// the path at all and naming one would describe something that
			// never happens.
			kind: TrackSourceKind.SystemAudio,
		},
	];
}

/**
 * Gets ordered track audio sources based on settings.
 */
export function getOrderedTrackSources(
	settings: AudioRecorderSettings,
): TrackAudioSource[] {
	// Asked before the stored tracks, because the pairing is the answer for a
	// session that configured none: its own predicate has already established
	// that the multi-track switch is off, so the two can never both apply.
	if (isSystemAudioPairingEnabled(settings)) {
		return systemAudioPairSources(settings);
	}
	const sources: TrackAudioSource[] = [];
	if (!settings.enableMultiTrack) {
		return sources;
	}
	for (let i = 1; i <= settings.maxTracks; i++) {
		const source = settings.trackAudioSources.get(i);
		const kind = source?.kind ?? TrackSourceKind.InputDevice;
		// A device track is configured by naming a device; a system-audio
		// track is configured by being one, and never carries an id.
		if (
			source &&
			(kind === TrackSourceKind.SystemAudio || source.deviceId)
		) {
			const systemAudio = kind === TrackSourceKind.SystemAudio;
			sources.push({
				trackNumber: i,
				deviceId: systemAudio ? '' : source.deviceId,
				// A system-audio track shows no channel row, because it names
				// no device whose layout there would be to describe. It must
				// carry no layout either: a mono pick stored while the track
				// was a device track would otherwise keep reducing a capture
				// no visible setting still accounts for.
				channelMode: systemAudio
					? ChannelMode.Source
					: normalizeChannelMode(source.channelMode),
				gainDb: source.gainDb ?? 0,
				pan: source.pan ?? 0,
				processing: source.processing ?? TrackProcessingMode.Global,
				kind,
			});
		}
	}
	return sources;
}

/**
 * Track numbers asking for the system output beyond the first one that does.
 *
 * A session can capture the machine's own output once. The grant is answered
 * by a handler installed on the Electron session, and that session holds one
 * handler at a time, so two tracks asking together overwrite and then clear
 * each other's. Reported as track numbers rather than as a count, because
 * both readers say which tracks to go and change: the capture refuses the
 * session with them named, and the settings entry carries a warning while any
 * of them is configured.
 * @param tracks - The session's tracks, as {@link getOrderedTrackSources}
 *   ordered them
 * @returns The surplus track numbers, empty when at most one asks
 */
export function surplusSystemAudioTracks(
	tracks: readonly TrackAudioSource[],
): number[] {
	return tracks
		.filter((source) => source.kind === TrackSourceKind.SystemAudio)
		.slice(1)
		.map((source) => source.trackNumber);
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
 *
 * The one fork here that asks {@link isMultiTrackSessionEnabled} rather than
 * {@link isTrackListSession}, because the question is which sentence the user
 * reads and not which path the capture takes. The system-audio pairing opens
 * a track list, and the only device in it is the single-track microphone, so
 * the second branch checks exactly the same id; sent down the first one it
 * would answer a user who never opened the multi-track page with a track
 * number instead of the row they set.
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
					source.kind !== TrackSourceKind.SystemAudio &&
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
