/**
 * Tests for the platform policy layer: platform detection and the
 * per-platform capability table. The capability functions are the single
 * place platform differences are decided, so these tests pin both the
 * desktop and the mobile policy - a change here is a deliberate product
 * decision, not an accident of refactoring.
 * @module tests/unit/platformCapabilities.test
 */

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
	isDecodableSize,
	isReadableSize,
	tooLargeToDecodeMessage,
	getMaxSourceReadBytes,
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
import {
	setPlatform,
	useDesktopPlatform,
	useMobilePlatform,
} from '../helpers/platform';

describe('platformKind', () => {
	it('resolves desktop when no mobile flag is set', () => {
		expect(getPlatformKind()).toBe('desktop');
		expect(isMobilePlatform()).toBe(false);
	});

	it('resolves mobile from Platform.isMobile', () => {
		setPlatform({ isMobile: true });
		expect(getPlatformKind()).toBe('mobile');
		expect(isMobilePlatform()).toBe(true);
	});

	it('resolves mobile from Platform.isMobileApp alone', () => {
		setPlatform({ isMobileApp: true });
		expect(getPlatformKind()).toBe('mobile');
	});

	it('reads the flags lazily on every call', () => {
		expect(getPlatformKind()).toBe('desktop');
		setPlatform({ isMobile: true });
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
		expect(desktop.maxSourceReadBytes).toBe(Number.POSITIVE_INFINITY);
		expect(mobile.chunkFlushThresholdBytes).toBe(MOBILE_BUFFER_LIMIT_BYTES);
		expect(mobile.maxDecodeBytes).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(mobile.maxSourceReadBytes).toBe(MOBILE_MAX_DECODE_BYTES);
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
		setPlatform({ isMobile: true });
		expect(getPlatformCapabilities()).toBe(
			getPlatformCapabilities('mobile'),
		);
	});
});

describe('capability helper functions', () => {
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
			setPlatform({ isMobile: true });
			expect(helper()).toBe(!desktopValue);
		},
	);

	describe.each([
		{
			platform: 'desktop' as const,
			flushThreshold: DESKTOP_FLUSH_THRESHOLD_BYTES,
			maxDecode: WAVEFORM_MAX_DECODE_BYTES,
			maxSplitSource: Number.POSITIVE_INFINITY,
			maxCleanupSamples: MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
			maxCleanupSeconds: MAX_AUDIO_CLEANUP_SECONDS,
		},
		{
			platform: 'mobile' as const,
			flushThreshold: MOBILE_BUFFER_LIMIT_BYTES,
			maxDecode: MOBILE_MAX_DECODE_BYTES,
			maxSplitSource: MOBILE_MAX_DECODE_BYTES,
			maxCleanupSamples: MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
			maxCleanupSeconds: MOBILE_MAX_AUDIO_CLEANUP_SECONDS,
		},
	])('the numeric limits on $platform', (limits) => {
		// Every one of these bounds memory-heavy work, and a phone that got a
		// desktop bound would be killed by the OS rather than degrade.
		it('flushes the chunk buffer at its threshold', () => {
			expect(getChunkFlushThresholdBytes(limits.platform)).toBe(
				limits.flushThreshold,
			);
		});

		it('bounds what may be decoded whole', () => {
			expect(getMaxDecodeBytes(limits.platform)).toBe(limits.maxDecode);
		});

		it('bounds the source a split may read', () => {
			expect(getMaxSourceReadBytes(limits.platform)).toBe(
				limits.maxSplitSource,
			);
		});

		it('bounds the samples a cleanup run may expand to', () => {
			expect(getMaxCleanupDecodedSamples(limits.platform)).toBe(
				limits.maxCleanupSamples,
			);
		});

		it('bounds the seconds a cleanup run may cover', () => {
			expect(getMaxCleanupSeconds(limits.platform)).toBe(
				limits.maxCleanupSeconds,
			);
		});
	});

	it('numeric getters follow the current platform by default', () => {
		expect(getMaxDecodeBytes()).toBe(WAVEFORM_MAX_DECODE_BYTES);
		setPlatform({ isMobile: true });
		expect(getMaxDecodeBytes()).toBe(MOBILE_MAX_DECODE_BYTES);
		expect(getChunkFlushThresholdBytes()).toBe(MOBILE_BUFFER_LIMIT_BYTES);
		expect(getMaxCleanupDecodedSamples()).toBe(
			MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
		);
		expect(getMaxCleanupSeconds()).toBe(MOBILE_MAX_AUDIO_CLEANUP_SECONDS);
	});

	it('answers whether a file may be decoded whole, per platform', () => {
		// One question for every path that expands a file to PCM - the
		// waveform, cleanup, the splitter, the metadata read - so none of them
		// can be the one that forgot to ask.
		expect(isDecodableSize(WAVEFORM_MAX_DECODE_BYTES, 'desktop')).toBe(
			true,
		);
		expect(isDecodableSize(WAVEFORM_MAX_DECODE_BYTES + 1, 'desktop')).toBe(
			false,
		);
		expect(isDecodableSize(MOBILE_MAX_DECODE_BYTES, 'mobile')).toBe(true);
		expect(isDecodableSize(MOBILE_MAX_DECODE_BYTES + 1, 'mobile')).toBe(
			false,
		);
	});

	it('follows the current platform when none is named', () => {
		expect(isDecodableSize(MOBILE_MAX_DECODE_BYTES + 1)).toBe(true);
		setPlatform({ isMobile: true });
		expect(isDecodableSize(MOBILE_MAX_DECODE_BYTES + 1)).toBe(false);
	});
});

// Reading a file whole and expanding it to PCM are two allocations, and only
// one of them grows the file. Answering the read with the decode ceiling
// refused work a platform does perfectly well: a streaming conversion or a
// lossless WAV split never decodes, and desktop reads a source of any size.
describe('whether a file may be read whole', () => {
	it('reads a source of any size on desktop', () => {
		expect(isReadableSize(WAVEFORM_MAX_DECODE_BYTES + 1, 'desktop')).toBe(
			true,
		);
		expect(getMaxSourceReadBytes('desktop')).toBe(Number.POSITIVE_INFINITY);
	});

	// On a phone, holding the bytes plus one working copy is itself most of
	// the allocation that gets the WebView killed.
	it('bounds the read on mobile', () => {
		expect(isReadableSize(MOBILE_MAX_DECODE_BYTES, 'mobile')).toBe(true);
		expect(isReadableSize(MOBILE_MAX_DECODE_BYTES + 1, 'mobile')).toBe(
			false,
		);
	});

	it('follows the current platform when none is named', () => {
		expect(isReadableSize(MOBILE_MAX_DECODE_BYTES + 1)).toBe(true);
		setPlatform({ isMobile: true });
		expect(isReadableSize(MOBILE_MAX_DECODE_BYTES + 1)).toBe(false);
	});

	// The two ceilings part company exactly where it matters: desktop reads
	// what it will not decode.
	it('parts company with the decode ceiling on desktop', () => {
		const past = WAVEFORM_MAX_DECODE_BYTES + 1;

		expect(isReadableSize(past, 'desktop')).toBe(true);
		expect(isDecodableSize(past, 'desktop')).toBe(false);
	});
});

// One limit, and until now three different pieces of advice about it: the
// splitter said one thing, cleanup another, and conversion said nothing at all
// because it never asked. The advice is a fact about the platform the limit
// belongs to, so it is written once here.
describe('what a user is told when a file will not decode', () => {
	it('points a phone at the desktop app, where the limit is far higher', () => {
		useMobilePlatform();

		expect(tooLargeToDecodeMessage('split')).toBe(
			'File is too large to split on this device. Convert or split it ' +
				'on desktop instead.',
		);
	});

	// On desktop there is no bigger machine to move to, so the advice is the
	// one thing that does help: make the file smaller first.
	it('tells a desktop user to split the file first', () => {
		useDesktopPlatform();

		expect(tooLargeToDecodeMessage('clean up')).toBe(
			'File is too large to clean up. Split it into parts first.',
		);
	});

	it('names the operation the user actually asked for', () => {
		useMobilePlatform();

		expect(tooLargeToDecodeMessage('convert')).toContain(
			'too large to convert',
		);
	});
});
