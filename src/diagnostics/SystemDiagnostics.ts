/**
 * System diagnostics data collector for the Audio Recorder plugin.
 * Gathers plugin settings, environment info, audio devices, and MediaRecorder capabilities.
 * @module diagnostics/SystemDiagnostics
 */

import type { App } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/Settings';
import { serializeTrackAudioSources } from '../settings/Settings';
import {
	detectCapabilities,
	detectCodecSupport,
	buildMimeType,
	validateRecordingCapability,
} from '../recording/AudioCapabilityDetector';
import type { CodecSupportEntry } from '../recording/AudioCapabilityDetector';

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
	trackAudioSources: Record<number, string>;
	audioDeviceId: string;
	debug: boolean;
}

/**
 * Environment information for diagnostics.
 */
export interface DiagnosticsEnvironment {
	obsidianVersion: string;
	electronVersion: string;
	nodeVersion: string;
	platform: string;
	arch: string;
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
	/** User-selected output format (e.g. 'mp4', 'wav'). */
	outputFormat: string;
	/** Actual MediaRecorder format (wav → 'webm' intermediary). */
	recorderFormat: string;
	/** MIME type passed to MediaRecorder (no codec suffix). */
	mimeType: string;
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
	audioDevices: DiagnosticsAudioDevice[];
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
	 * @param app - The Obsidian App instance
	 * @returns Environment info object
	 */
	static collectEnvironment(app: App): DiagnosticsEnvironment {
		const apiVersion =
			(app as unknown as { apiVersion?: string }).apiVersion ?? 'unknown';
		const proc = (typeof process !== 'undefined' ? process : null) as {
			type?: string;
			versions?: {
				electron?: string;
				node?: string;
			};
			platform?: string;
			arch?: string;
		} | null;

		const electronVersion = proc?.versions?.electron ?? 'unknown';
		const nodeVersion = proc?.versions?.node ?? 'unknown';
		const platform = proc?.platform ?? 'unknown';
		const arch = proc?.arch ?? 'unknown';

		return {
			obsidianVersion: apiVersion,
			electronVersion,
			nodeVersion,
			platform,
			arch,
			userAgent: 'unknown',
		};
	}

	/**
	 * Enumerates all available audio devices.
	 * @returns Array of audio device descriptors
	 */
	static async collectAudioDevices(): Promise<DiagnosticsAudioDevice[]> {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices
			.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
			.map((d) => ({
				deviceId: d.deviceId,
				label: d.label,
				groupId: d.groupId,
				kind: d.kind,
			}));
	}

	/**
	 * Detects audio recording capabilities of the current environment.
	 * @returns Audio capabilities descriptor
	 */
	static collectAudioCapabilities(): DiagnosticsAudioCapabilities {
		const capabilities = detectCapabilities();
		const mediaRecorderAvailable = typeof MediaRecorder !== 'undefined';
		const getUserMediaAvailable =
			typeof navigator.mediaDevices !== 'undefined' &&
			typeof navigator.mediaDevices.getUserMedia === 'function';

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
	 * Resolves the active recording configuration for the given settings.
	 * Mirrors the logic in RecordingManager.resolveRecorderFormat() so that
	 * diagnostics exactly reflect what would be used during recording.
	 * @param settings - Current plugin settings
	 * @returns Active recording configuration
	 */
	static collectActiveRecordingConfig(
		settings: AudioRecorderSettings,
	): ActiveRecordingConfig {
		const outputFormat = settings.recordingFormat.toLowerCase();
		const validationResult = validateRecordingCapability(outputFormat);

		// For WAV output, MediaRecorder uses a compressed intermediate (webm/ogg).
		// Mirror the same precedence as RecordingManager.resolveRecorderFormat().
		if (outputFormat === 'wav') {
			const intermediates = ['webm', 'ogg'];
			for (const format of intermediates) {
				const mimeType = buildMimeType(format);
				const supported =
					typeof MediaRecorder !== 'undefined' &&
					MediaRecorder.isTypeSupported(mimeType);
				if (supported) {
					return {
						outputFormat,
						recorderFormat: format,
						mimeType,
						mimeTypeSupported: true,
						validationResult,
					};
				}
			}
			// Neither webm nor ogg available — report the failure.
			return {
				outputFormat,
				recorderFormat: 'webm',
				mimeType: buildMimeType('webm'),
				mimeTypeSupported: false,
				validationResult,
			};
		}

		const mimeType = buildMimeType(outputFormat);
		const mimeTypeSupported =
			typeof MediaRecorder !== 'undefined' &&
			MediaRecorder.isTypeSupported(mimeType);

		return {
			outputFormat,
			recorderFormat: outputFormat,
			mimeType,
			mimeTypeSupported,
			validationResult,
		};
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
		const [audioDevices] = await Promise.all([
			SystemDiagnostics.collectAudioDevices(),
		]);

		return {
			pluginSettings: SystemDiagnostics.collectPluginSettings(settings),
			environment: SystemDiagnostics.collectEnvironment(app),
			audioDevices,
			audioCapabilities: SystemDiagnostics.collectAudioCapabilities(),
			activeRecordingConfig:
				SystemDiagnostics.collectActiveRecordingConfig(settings),
		};
	}
}
