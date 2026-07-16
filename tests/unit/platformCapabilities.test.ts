/**
 * Tests for the platform policy layer: platform detection and the
 * per-platform capability table. The capability functions are the single
 * place platform differences are decided, so these tests pin both the
 * desktop and the mobile policy - a change here is a deliberate product
 * decision, not an accident of refactoring.
 * @module tests/unit/platformCapabilities.test
 */

import { Platform } from 'obsidian';
import {
	getPlatformKind,
	isMobilePlatform,
	normalizePlatformKind,
	PLATFORM_KINDS,
} from 'src/platform/platformKind';
import {
	getChunkFlushThresholdBytes,
	getMaxCleanupDecodedSamples,
	getMaxCleanupSeconds,
	getMaxDecodeBytes,
	getMaxSplitSourceBytes,
	getPlatformCapabilities,
	isAutoSplitSupported,
	isChannelModeSelectionSupported,
	isDeviceSelectionSupported,
	isLocalTranscriptionSupported,
	isMultiTrackCaptureSupported,
	isPcmWavCaptureSupported,
	isRecordingBannerSupported,
	isRecoveryJournalSupported,
	isSampleRateSelectionSupported,
} from 'src/platform/capabilities';
import {
	DESKTOP_FLUSH_THRESHOLD_BYTES,
	MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
	MAX_AUDIO_CLEANUP_SECONDS,
	MOBILE_BUFFER_LIMIT_BYTES,
	MOBILE_MAX_AUDIO_CLEANUP_SECONDS,
	MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
	MOBILE_MAX_DECODE_BYTES,
	WAVEFORM_MAX_DECODE_BYTES,
} from 'src/constants';

/** Restores the mocked Platform to desktop after each test. */
function resetPlatform(): void {
	Platform.isMobile = false;
	Platform.isMobileApp = false;
}

describe('platformKind', () => {
	afterEach(resetPlatform);

	it('resolves desktop when no mobile flag is set', () => {
		expect(getPlatformKind()).toBe('desktop');
		expect(isMobilePlatform()).toBe(false);
	});

	it('resolves mobile from Platform.isMobile', () => {
		Platform.isMobile = true;
		expect(getPlatformKind()).toBe('mobile');
		expect(isMobilePlatform()).toBe(true);
	});

	it('resolves mobile from Platform.isMobileApp alone', () => {
		Platform.isMobileApp = true;
		expect(getPlatformKind()).toBe('mobile');
	});

	it('reads the flags lazily on every call', () => {
		expect(getPlatformKind()).toBe('desktop');
		Platform.isMobile = true;
		expect(getPlatformKind()).toBe('mobile');
	});

	it('lists every platform kind exactly once', () => {
		expect([...PLATFORM_KINDS].sort()).toEqual(['desktop', 'mobile']);
	});

	it('normalizes known platform keys and rejects everything else', () => {
		expect(normalizePlatformKind('desktop')).toBe('desktop');
		expect(normalizePlatformKind('mobile')).toBe('mobile');
		expect(normalizePlatformKind('tablet')).toBeNull();
		expect(normalizePlatformKind(undefined)).toBeNull();
		expect(normalizePlatformKind(42)).toBeNull();
	});
});

describe('platform capability table', () => {
	afterEach(resetPlatform);

	it('desktop allows the full feature set', () => {
		const desktop = getPlatformCapabilities('desktop');
		expect(desktop.multiTrackCapture).toBe(true);
		expect(desktop.deviceSelection).toBe(true);
		expect(desktop.channelModeSelection).toBe(true);
		expect(desktop.sampleRateSelection).toBe(true);
		expect(desktop.autoSplit).toBe(true);
		expect(desktop.pcmWavCapture).toBe(true);
		expect(desktop.recoveryJournal).toBe(true);
		expect(desktop.localTranscription).toBe(true);
		expect(desktop.recordingBanner).toBe(false);
	});

	it('mobile blocks the desktop-only features and uses the banner', () => {
		const mobile = getPlatformCapabilities('mobile');
		expect(mobile.multiTrackCapture).toBe(false);
		expect(mobile.deviceSelection).toBe(false);
		expect(mobile.channelModeSelection).toBe(false);
		expect(mobile.sampleRateSelection).toBe(false);
		expect(mobile.autoSplit).toBe(false);
		expect(mobile.pcmWavCapture).toBe(false);
		expect(mobile.recoveryJournal).toBe(false);
		expect(mobile.localTranscription).toBe(false);
		expect(mobile.recordingBanner).toBe(true);
	});

	it('bounds memory-heavy work far lower on mobile than on desktop', () => {
		const desktop = getPlatformCapabilities('desktop');
		const mobile = getPlatformCapabilities('mobile');
		expect(desktop.chunkFlushThresholdBytes).toBe(
			DESKTOP_FLUSH_THRESHOLD_BYTES,
		);
		expect(desktop.maxDecodeBytes).toBe(WAVEFORM_MAX_DECODE_BYTES);
		expect(desktop.maxCleanupDecodedSamples).toBe(
			MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
		);
		expect(desktop.maxCleanupSeconds).toBe(MAX_AUDIO_CLEANUP_SECONDS);
		expect(desktop.maxSplitSourceBytes).toBe(Number.POSITIVE_INFINITY);
		expect(mobile.chunkFlushThresholdBytes).toBe(MOBILE_BUFFER_LIMIT_BYTES);
		expect(mobile.maxDecodeBytes).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(mobile.maxSplitSourceBytes).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(mobile.maxCleanupDecodedSamples).toBe(
			MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
		);
		expect(mobile.maxCleanupSeconds).toBe(MOBILE_MAX_AUDIO_CLEANUP_SECONDS);
		expect(mobile.maxDecodeBytes).toBeLessThan(desktop.maxDecodeBytes);
		expect(mobile.maxCleanupDecodedSamples).toBeLessThan(
			desktop.maxCleanupDecodedSamples,
		);
		expect(mobile.maxCleanupSeconds).toBeLessThan(
			desktop.maxCleanupSeconds,
		);
	});

	it('resolves the current platform lazily when no kind is given', () => {
		expect(getPlatformCapabilities()).toBe(
			getPlatformCapabilities('desktop'),
		);
		Platform.isMobile = true;
		expect(getPlatformCapabilities()).toBe(
			getPlatformCapabilities('mobile'),
		);
	});
});

describe('capability helper functions', () => {
	afterEach(resetPlatform);

	it.each([
		['isMultiTrackCaptureSupported', isMultiTrackCaptureSupported, true],
		['isDeviceSelectionSupported', isDeviceSelectionSupported, true],
		[
			'isChannelModeSelectionSupported',
			isChannelModeSelectionSupported,
			true,
		],
		[
			'isSampleRateSelectionSupported',
			isSampleRateSelectionSupported,
			true,
		],
		['isAutoSplitSupported', isAutoSplitSupported, true],
		['isPcmWavCaptureSupported', isPcmWavCaptureSupported, true],
		['isRecoveryJournalSupported', isRecoveryJournalSupported, true],
		['isLocalTranscriptionSupported', isLocalTranscriptionSupported, true],
		['isRecordingBannerSupported', isRecordingBannerSupported, false],
	] as const)(
		'%s answers per platform and flips on mobile',
		(_name, helper, desktopValue) => {
			expect(helper('desktop')).toBe(desktopValue);
			expect(helper('mobile')).toBe(!desktopValue);
			// Defaults to the current platform
			expect(helper()).toBe(desktopValue);
			Platform.isMobile = true;
			expect(helper()).toBe(!desktopValue);
		},
	);

	it('returns the platform-specific numeric limits', () => {
		expect(getChunkFlushThresholdBytes('desktop')).toBe(
			DESKTOP_FLUSH_THRESHOLD_BYTES,
		);
		expect(getChunkFlushThresholdBytes('mobile')).toBe(
			MOBILE_BUFFER_LIMIT_BYTES,
		);
		expect(getMaxDecodeBytes('desktop')).toBe(WAVEFORM_MAX_DECODE_BYTES);
		expect(getMaxDecodeBytes('mobile')).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(getMaxSplitSourceBytes('desktop')).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(getMaxSplitSourceBytes('mobile')).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(getMaxCleanupDecodedSamples('desktop')).toBe(
			MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
		);
		expect(getMaxCleanupDecodedSamples('mobile')).toBe(
			MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
		);
		expect(getMaxCleanupSeconds('desktop')).toBe(MAX_AUDIO_CLEANUP_SECONDS);
		expect(getMaxCleanupSeconds('mobile')).toBe(
			MOBILE_MAX_AUDIO_CLEANUP_SECONDS,
		);
	});

	it('numeric getters follow the current platform by default', () => {
		expect(getMaxDecodeBytes()).toBe(WAVEFORM_MAX_DECODE_BYTES);
		Platform.isMobile = true;
		expect(getMaxDecodeBytes()).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(getChunkFlushThresholdBytes()).toBe(MOBILE_BUFFER_LIMIT_BYTES);
		expect(getMaxCleanupDecodedSamples()).toBe(
			MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
		);
		expect(getMaxCleanupSeconds()).toBe(MOBILE_MAX_AUDIO_CLEANUP_SECONDS);
	});
});
