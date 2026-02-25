/** @jest-environment jsdom */
/**
 * Unit tests for SystemDiagnostics.
 * @module tests/unit/SystemDiagnostics
 */

import { SystemDiagnostics } from 'src/diagnostics/SystemDiagnostics';
import type { AudioRecorderSettings } from 'src/settings/Settings';
import * as AudioCapabilityDetector from 'src/recording/AudioCapabilityDetector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(
    overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
    return {
        recordingFormat: 'webm',
        bitrate: 128000,
        sampleRate: 44100,
        saveFolder: 'recordings',
        saveNearActiveFile: false,
        activeFileSubfolder: '',
        filePrefix: 'recording',
        startStopHotkey: '',
        pauseHotkey: '',
        resumeHotkey: '',
        audioDeviceId: 'device-1',
        enableMultiTrack: false,
        maxTracks: 2,
        outputMode: 'single',
        useSourceNamesForTracks: true,
        trackAudioSources: new Map([
            [1, { deviceId: 'dev-a' }],
            [2, { deviceId: 'dev-b' }],
        ]),
        debug: true,
        ...overrides,
    };
}

function makeApp(apiVersion = '1.5.0') {
    return { apiVersion } as unknown as Parameters<
        typeof SystemDiagnostics.collectEnvironment
    >[0];
}

// ---------------------------------------------------------------------------
// collectPluginSettings
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectPluginSettings', () => {
    it('serializes all scalar settings fields', () => {
        const settings = makeSettings();
        const result = SystemDiagnostics.collectPluginSettings(settings);

        expect(result.recordingFormat).toBe('webm');
        expect(result.bitrate).toBe(128000);
        expect(result.sampleRate).toBe(44100);
        expect(result.saveFolder).toBe('recordings');
        expect(result.saveNearActiveFile).toBe(false);
        expect(result.activeFileSubfolder).toBe('');
        expect(result.filePrefix).toBe('recording');
        expect(result.enableMultiTrack).toBe(false);
        expect(result.maxTracks).toBe(2);
        expect(result.outputMode).toBe('single');
        expect(result.audioDeviceId).toBe('device-1');
        expect(result.debug).toBe(true);
    });

    it('serializes trackAudioSources Map to a plain Record', () => {
        const settings = makeSettings();
        const result = SystemDiagnostics.collectPluginSettings(settings);

        expect(result.trackAudioSources).toEqual({ 1: 'dev-a', 2: 'dev-b' });
    });

    it('handles empty trackAudioSources', () => {
        const settings = makeSettings({ trackAudioSources: new Map() });
        const result = SystemDiagnostics.collectPluginSettings(settings);

        expect(result.trackAudioSources).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// collectEnvironment
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectEnvironment', () => {
    const originalProcess = global.process;

    afterEach(() => {
        // eslint-disable-next-line
        (global as unknown as { process: NodeJS.Process }).process = originalProcess;
    });

    it('reads apiVersion from app', () => {
        const app = makeApp('1.7.3');
        const result = SystemDiagnostics.collectEnvironment(app);

        expect(result.obsidianVersion).toBe('1.7.3');
    });

    it('reads electron and node versions from process.versions', () => {
        const proc = {
            versions: { electron: '28.0.0', node: '20.11.0' },
            platform: 'win32',
            arch: 'x64',
        };
        // eslint-disable-next-line -- test override of global
        (global as unknown as { process: typeof proc }).process = proc;

        const result = SystemDiagnostics.collectEnvironment(makeApp());

        expect(result.electronVersion).toBe('28.0.0');
        expect(result.nodeVersion).toBe('20.11.0');
        expect(result.platform).toBe('win32');
        expect(result.arch).toBe('x64');
    });

    it('uses "unknown" when process.platform is absent', () => {
        const proc = { versions: { electron: '28.0.0', node: '20.11.0' } };
        // eslint-disable-next-line -- test override of global
        (global as unknown as { process: typeof proc }).process = proc;

        const result = SystemDiagnostics.collectEnvironment(makeApp());

        expect(result.platform).toBe('unknown');
    });

    it('returns "unknown" for electronVersion when process is undefined', () => {
        // eslint-disable-next-line -- test override of global
        (global as unknown as { process: undefined }).process = undefined;

        const result = SystemDiagnostics.collectEnvironment(makeApp());

        expect(result.electronVersion).toBe('unknown');
        expect(result.nodeVersion).toBe('unknown');
        expect(result.arch).toBe('unknown');
    });

    it('returns "unknown" obsidianVersion when app has no apiVersion', () => {
        const app = {} as Parameters<
            typeof SystemDiagnostics.collectEnvironment
        >[0];
        const result = SystemDiagnostics.collectEnvironment(app);

        expect(result.obsidianVersion).toBe('unknown');
    });

    it('returns "unknown" for userAgent', () => {
        const result = SystemDiagnostics.collectEnvironment(makeApp());

        expect(result.userAgent).toBe('unknown');
    });
});

// ---------------------------------------------------------------------------
// collectAudioDevices
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectAudioDevices', () => {
    const mockEnumerate = jest.fn();

    beforeEach(() => {
        Object.defineProperty(global.navigator, 'mediaDevices', {
            value: { enumerateDevices: mockEnumerate },
            configurable: true,
        });
    });

    it('returns audioinput and audiooutput devices', async () => {
        mockEnumerate.mockResolvedValueOnce([
            {
                deviceId: 'in-1',
                label: 'Mic 1',
                groupId: 'grp-1',
                kind: 'audioinput',
            },
            {
                deviceId: 'out-1',
                label: 'Speaker 1',
                groupId: 'grp-2',
                kind: 'audiooutput',
            },
            {
                deviceId: 'vid-1',
                label: 'Camera',
                groupId: 'grp-3',
                kind: 'videoinput',
            },
        ]);

        const result = await SystemDiagnostics.collectAudioDevices();

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            deviceId: 'in-1',
            label: 'Mic 1',
            groupId: 'grp-1',
            kind: 'audioinput',
        });
        expect(result[1]).toEqual({
            deviceId: 'out-1',
            label: 'Speaker 1',
            groupId: 'grp-2',
            kind: 'audiooutput',
        });
    });

    it('returns empty array when no audio devices exist', async () => {
        mockEnumerate.mockResolvedValueOnce([]);

        const result = await SystemDiagnostics.collectAudioDevices();

        expect(result).toEqual([]);
    });

    it('filters out videoinput devices', async () => {
        mockEnumerate.mockResolvedValueOnce([
            {
                deviceId: 'vid-1',
                label: 'Camera',
                groupId: 'g1',
                kind: 'videoinput',
            },
        ]);

        const result = await SystemDiagnostics.collectAudioDevices();

        expect(result).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// collectAudioCapabilities
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectAudioCapabilities', () => {
    const mockDetectCapabilities = jest.spyOn(
        AudioCapabilityDetector,
        'detectCapabilities',
    );

    beforeEach(() => {
        mockDetectCapabilities.mockReset();
    });

    it('maps detectCapabilities result to capabilities object', () => {
        mockDetectCapabilities.mockReturnValueOnce({
            supportedFormats: ['webm', 'ogg'],
            supportedSampleRates: [44100, 48000],
            supportedBitrates: [128000, 256000],
            defaultFormat: 'webm',
            defaultSampleRate: 44100,
            defaultBitrate: 128000,
        });

        const result = SystemDiagnostics.collectAudioCapabilities();

        expect(result.supportedFormats).toEqual(['webm', 'ogg']);
        expect(result.supportedSampleRates).toEqual([44100, 48000]);
        expect(result.supportedBitrates).toEqual([128000, 256000]);
    });

    it('reports mediaRecorderAvailable as true when MediaRecorder exists', () => {
        mockDetectCapabilities.mockReturnValueOnce({
            supportedFormats: [],
            supportedSampleRates: [],
            supportedBitrates: [],
            defaultFormat: 'webm',
            defaultSampleRate: 44100,
            defaultBitrate: 128000,
        });

        // MediaRecorder appears in jsdom
        const result = SystemDiagnostics.collectAudioCapabilities();

        expect(result.mediaRecorderAvailable).toBe(typeof MediaRecorder !== 'undefined');
    });

    it('reports getUserMediaAvailable based on navigator.mediaDevices', () => {
        mockDetectCapabilities.mockReturnValueOnce({
            supportedFormats: [],
            supportedSampleRates: [],
            supportedBitrates: [],
            defaultFormat: 'webm',
            defaultSampleRate: 44100,
            defaultBitrate: 128000,
        });

        const result = SystemDiagnostics.collectAudioCapabilities();

        const expected =
            typeof navigator.mediaDevices !== 'undefined' &&
            typeof navigator.mediaDevices.getUserMedia === 'function';
        expect(result.getUserMediaAvailable).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// collect (integration)
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collect', () => {
    const mockEnumerate = jest.fn();
    const mockDetectCapabilities = jest.spyOn(
        AudioCapabilityDetector,
        'detectCapabilities',
    );

    beforeEach(() => {
        Object.defineProperty(global.navigator, 'mediaDevices', {
            value: { enumerateDevices: mockEnumerate },
            configurable: true,
        });
        mockEnumerate.mockResolvedValue([]);
        mockDetectCapabilities.mockReturnValue({
            supportedFormats: ['webm'],
            supportedSampleRates: [44100],
            supportedBitrates: [128000],
            defaultFormat: 'webm',
            defaultSampleRate: 44100,
            defaultBitrate: 128000,
        });
    });

    afterEach(() => {
        mockDetectCapabilities.mockReset();
    });

    it('returns a complete DiagnosticsData object', async () => {
        const settings = makeSettings();
        const app = makeApp('1.6.0');

        const result = await SystemDiagnostics.collect(settings, app);

        expect(result).toHaveProperty('pluginSettings');
        expect(result).toHaveProperty('environment');
        expect(result).toHaveProperty('audioDevices');
        expect(result).toHaveProperty('audioCapabilities');
        expect(result.environment.obsidianVersion).toBe('1.6.0');
        expect(result.pluginSettings.recordingFormat).toBe('webm');
        expect(Array.isArray(result.audioDevices)).toBe(true);
    });

    it('propagates audio devices collected asynchronously', async () => {
        mockEnumerate.mockResolvedValueOnce([
            {
                deviceId: 'in-1',
                label: 'Mic',
                groupId: 'g1',
                kind: 'audioinput',
            },
        ]);

        const result = await SystemDiagnostics.collect(makeSettings(), makeApp());

        expect(result.audioDevices).toHaveLength(1);
        expect(result.audioDevices[0].deviceId).toBe('in-1');
    });
});
