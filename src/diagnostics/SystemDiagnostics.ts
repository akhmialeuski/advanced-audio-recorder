/**
 * System diagnostics data collector for the Audio Recorder plugin.
 * Gathers plugin settings, environment info, audio devices, and MediaRecorder capabilities.
 * @module diagnostics/SystemDiagnostics
 */

import { apiVersion } from 'obsidian';
import type { App } from 'obsidian';
import type {
	AudioRecorderSettings,
	SerializedAudioSource,
} from '../settings/settingsSchema';
import { serializeTrackAudioSources } from '../settings/settingsSerialization';
import {
	detectCapabilities,
	detectCodecSupport,
	getExpectedCodec,
	buildMimeType,
	resolveEffectiveOutputFormat,
	validateRecordingCapability,
} from '../audio/AudioCapabilityDetector';
import type { CodecSupportEntry } from '../audio/AudioCapabilityDetector';
import { resolveRecorderFormat } from '../audio/AudioFormatConverter';
import { audioDeviceApi } from '../recording/AudioStreamHandler';
import { PLUGIN_LOG_PREFIX } from '../constants';

/**
 * Serialized plugin settings for diagnostics.
 */
export interface DiagnosticsPluginSettings {
	recordingFormat: string;
	bitrate: number;
	sampleRate: number;
	saveFolder: string;
	saveNearActiveFile: boolean;
	activeFileSubfolder: string;
	filePrefix: string;
	enableMultiTrack: boolean;
	maxTracks: number;
	outputMode: string;
	trackAudioSources: Record<number, SerializedAudioSource>;
	audioDeviceId: string;
	debug: boolean;
}

/**
 * Environment information for diagnostics.
 */
export interface DiagnosticsEnvironment {
	obsidianVersion: string;
	electronVersion: string;
	/**
	 * Chromium version of the WebView, which is what every codec answer in
	 * this report was probed against.
	 *
	 * It travels with the installer, not with the Obsidian version: two vaults
	 * reporting the same obsidianVersion run different Chromium builds until
	 * the newer installer has actually been run, and that difference is what
	 * makes a format recordable on one of them and not the other. Without it a
	 * report says which Obsidian the user runs but not which browser, and the
	 * codec probe below it cannot be reproduced.
	 *
	 * 'unknown' where the runtime exposes no process object - mobile, where
	 * {@link DiagnosticsEnvironment.userAgent} carries the WebView version
	 * instead.
	 */
	chromeVersion: string;
	nodeVersion: string;
	platform: string;
	arch: string;
	/**
	 * The WebView's own identification. The only place a version comes from on
	 * mobile, where there is no Electron and no process to ask.
	 */
	userAgent: string;
}

/**
 * Audio device info for diagnostics.
 */
export interface DiagnosticsAudioDevice {
	deviceId: string;
	label: string;
	groupId: string;
	kind: string;
}

/**
 * The audio devices this environment lists, and whether it could be asked.
 *
 * An empty list on its own reads as "this machine has no audio hardware",
 * which is the one thing it does not mean when the list could not be read:
 * an environment exposing no device API, or an enumeration the platform
 * refused because microphone access is blocked. A report is asked for in
 * exactly those situations, so it has to say which of the three it is.
 */
export interface DiagnosticsAudioDevices {
	/** Whether the device list could be read at all. */
	enumerated: boolean;
	/** The devices listed, empty when the list could not be read. */
	devices: DiagnosticsAudioDevice[];
}

/**
 * Audio capabilities for diagnostics.
 */
export interface DiagnosticsAudioCapabilities {
	supportedFormats: string[];
	supportedSampleRates: number[];
	supportedBitrates: number[];
	codecSupport: CodecSupportEntry[];
	mediaRecorderAvailable: boolean;
	getUserMediaAvailable: boolean;
}

/**
 * Active recording configuration resolved from current settings.
 */
export interface ActiveRecordingConfig {
	/**
	 * The output format recording will actually use: the stored preference
	 * when the device can record it, otherwise the platform fallback. The
	 * stored preference itself stays under pluginSettings.recordingFormat,
	 * so a difference between the two surfaces a fallback.
	 */
	outputFormat: string;
	/** The format actually given to MediaRecorder (handles wav -> 'webm' intermediary). */
	recorderFormat: string;
	/** MIME type passed to MediaRecorder (no codec suffix). */
	mimeType: string;
	/** The expected codec that the browser will select for this format. */
	expectedCodec?: string | undefined;
	/** Whether MediaRecorder.isTypeSupported() returns true for the mimeType. */
	mimeTypeSupported: boolean;
	/** Pre-recording validation result. */
	validationResult: { valid: boolean; reason: string };
}

/**
 * Full diagnostics data snapshot.
 */
export interface DiagnosticsData {
	pluginSettings: DiagnosticsPluginSettings;
	environment: DiagnosticsEnvironment;
	audioDevices: DiagnosticsAudioDevices;
	audioCapabilities: DiagnosticsAudioCapabilities;
	activeRecordingConfig: ActiveRecordingConfig;
}

/**
 * Collects system diagnostics for the Audio Recorder plugin.
 */
export class SystemDiagnostics {
	/**
	 * Serializes the current plugin settings into a plain diagnostics object.
	 * @param settings - Current plugin settings
	 * @returns Serialized settings object
	 */
	static collectPluginSettings(
		settings: AudioRecorderSettings,
	): DiagnosticsPluginSettings {
		return {
			recordingFormat: settings.recordingFormat,
			bitrate: settings.bitrate,
			sampleRate: settings.sampleRate,
			saveFolder: settings.saveFolder,
			saveNearActiveFile: settings.saveNearActiveFile,
			activeFileSubfolder: settings.activeFileSubfolder,
			filePrefix: settings.filePrefix,
			enableMultiTrack: settings.enableMultiTrack,
			maxTracks: settings.maxTracks,
			outputMode: settings.outputMode,
			trackAudioSources: serializeTrackAudioSources(
				settings.trackAudioSources,
			),
			audioDeviceId: settings.audioDeviceId,
			debug: settings.debug,
		};
	}

	/**
	 * Collects Obsidian and runtime environment information.
	 * @param _app - The Obsidian App instance (kept for signature stability;
	 *   the API version now comes from obsidian's module-level export)
	 * @returns Environment info object
	 */
	static collectEnvironment(_app: App): DiagnosticsEnvironment {
		// The API version ships as a module-level export; the old cast read a
		// non-existent app property and always fell back to 'unknown'.
		const proc = (typeof process !== 'undefined' ? process : null) as {
			type?: string;
			versions?: {
				electron?: string;
				node?: string;
				chrome?: string;
			};
			platform?: string;
			arch?: string;
		} | null;

		const electronVersion = proc?.versions?.electron ?? 'unknown';
		const chromeVersion = proc?.versions?.chrome ?? 'unknown';
		const nodeVersion = proc?.versions?.node ?? 'unknown';
		const platform = proc?.platform ?? 'unknown';
		const arch = proc?.arch ?? 'unknown';
		// Read through the same guard as process: the mobile WebView has a
		// navigator and no process, and a test environment may have neither.
		// An empty string counts as no answer rather than as an answer.
		const nav = (typeof navigator !== 'undefined' ? navigator : null) as {
			userAgent?: string;
		} | null;
		const agent = nav?.userAgent;

		return {
			obsidianVersion: apiVersion,
			electronVersion,
			chromeVersion,
			nodeVersion,
			platform,
			arch,
			userAgent: agent === undefined || agent === '' ? 'unknown' : agent,
		};
	}

	/**
	 * Enumerates all available audio devices, reporting whether the list
	 * could be read rather than answering "no devices" either way.
	 *
	 * A refused enumeration is answered here rather than thrown, because this
	 * runs inside the snapshot's Promise.all: rejecting took the whole report
	 * down, and blocked microphone access is one of the situations the report
	 * exists to describe.
	 * @returns The devices listed, and whether the list could be read
	 */
	static async collectAudioDevices(): Promise<DiagnosticsAudioDevices> {
		const api = audioDeviceApi();
		if (!api) {
			return { enumerated: false, devices: [] };
		}
		try {
			const devices = await api.enumerateDevices();
			return {
				enumerated: true,
				devices: devices
					.filter(
						(d) =>
							d.kind === 'audioinput' || d.kind === 'audiooutput',
					)
					.map((d) => ({
						deviceId: d.deviceId,
						label: d.label,
						groupId: d.groupId,
						kind: d.kind,
					})),
			};
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Audio devices could not be listed for the diagnostics report:`,
				error,
			);
			return { enumerated: false, devices: [] };
		}
	}

	/**
	 * Detects audio recording capabilities of the current environment.
	 * @returns Audio capabilities descriptor
	 */
	static async collectAudioCapabilities(): Promise<DiagnosticsAudioCapabilities> {
		const capabilities = await detectCapabilities();
		const mediaRecorderAvailable = typeof MediaRecorder !== 'undefined';
		const getUserMediaAvailable =
			typeof audioDeviceApi()?.getUserMedia === 'function';

		return {
			supportedFormats: capabilities.supportedFormats,
			supportedSampleRates: capabilities.supportedSampleRates,
			supportedBitrates: capabilities.supportedBitrates,
			codecSupport: detectCodecSupport(),
			mediaRecorderAvailable,
			getUserMediaAvailable,
		};
	}

	/**
	 * Resolves the active recording configuration for the given settings
	 * through the same steps the recording pipeline uses
	 * (resolveEffectiveOutputFormat, then resolveRecorderFormat), so the
	 * reported output format, recorder, and MIME reflect what recording
	 * would actually do - the platform fallback included when the stored
	 * format cannot be recorded here. The validation result is of the
	 * stored preference, so the cause of a fallback stays visible.
	 * @param settings - Current plugin settings
	 * @returns Active recording configuration
	 */
	static async collectActiveRecordingConfig(
		settings: AudioRecorderSettings,
	): Promise<ActiveRecordingConfig> {
		const requestedFormat = settings.recordingFormat.toLowerCase();
		// Validate the stored preference so a fallback's cause (why the
		// requested format is unrecordable here) stays in the report.
		const validationResult =
			await validateRecordingCapability(requestedFormat);

		// Resolve the format recording will actually use: the request when
		// recordable, else the platform fallback. Diagnostics then mirror
		// the effective session instead of an unrecordable preference.
		let outputFormat = requestedFormat;
		try {
			outputFormat = (await resolveEffectiveOutputFormat(requestedFormat))
				.format;
		} catch {
			// Nothing is recordable here; keep the requested format so the
			// unsupported branch below reports it honestly.
		}

		try {
			const resolved = resolveRecorderFormat(outputFormat);
			return {
				outputFormat,
				recorderFormat: resolved.recorderFormat,
				mimeType: resolved.mimeType,
				expectedCodec:
					resolved.recorderFormat === outputFormat
						? getExpectedCodec(outputFormat)
						: undefined,
				mimeTypeSupported: true,
				validationResult,
			};
		} catch {
			// No recorder format available: report the direct MIME type of
			// the effective output as unsupported.
			return {
				outputFormat,
				recorderFormat: outputFormat,
				mimeType: buildMimeType(outputFormat),
				mimeTypeSupported: false,
				validationResult,
			};
		}
	}

	/**
	 * Collects the full diagnostics snapshot.
	 * @param settings - Current plugin settings
	 * @param app - The Obsidian App instance
	 * @returns Complete diagnostics data
	 */
	static async collect(
		settings: AudioRecorderSettings,
		app: App,
	): Promise<DiagnosticsData> {
		const [audioDevices, audioCapabilities, activeRecordingConfig] =
			await Promise.all([
				SystemDiagnostics.collectAudioDevices(),
				SystemDiagnostics.collectAudioCapabilities(),
				SystemDiagnostics.collectActiveRecordingConfig(settings),
			]);

		return {
			pluginSettings: SystemDiagnostics.collectPluginSettings(settings),
			environment: SystemDiagnostics.collectEnvironment(app),
			audioDevices,
			audioCapabilities,
			activeRecordingConfig,
		};
	}
}
