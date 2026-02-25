/**
 * System diagnostics data collector for the Audio Recorder plugin.
 * Gathers plugin settings, environment info, audio devices, and MediaRecorder capabilities.
 * @module diagnostics/SystemDiagnostics
 */

import type { App } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/Settings';
import { serializeTrackAudioSources } from '../settings/Settings';
import { detectCapabilities } from '../recording/AudioCapabilityDetector';

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
	mediaRecorderAvailable: boolean;
	getUserMediaAvailable: boolean;
}

/**
 * Full diagnostics data snapshot.
 */
export interface DiagnosticsData {
	pluginSettings: DiagnosticsPluginSettings;
	environment: DiagnosticsEnvironment;
	audioDevices: DiagnosticsAudioDevice[];
	audioCapabilities: DiagnosticsAudioCapabilities;
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
			mediaRecorderAvailable,
			getUserMediaAvailable,
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
		};
	}
}
