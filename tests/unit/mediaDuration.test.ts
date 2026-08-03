/**
 * @jest-environment jsdom
 *
 * Covers the media read that answers how long a recording is when its
 * container does not say. It is the reader that keeps a full PCM decode off
 * the routine path, so what matters here is that it resolves the length a
 * streamed container withholds, that it gives up rather than hangs, and that
 * it leaves neither a loaded element nor a live object URL behind.
 * @module tests/unit/mediaDuration.test
 */

import {
	DURATION_PROBE_SECONDS,
	probeBlobDurationSeconds,
	probeMediaDurationSeconds,
	usableSeconds,
} from 'src/utils/mediaDuration';
import {
	installAudioElementMock,
	installObjectUrlMock,
	type AudioElementDouble,
	type InstalledMock,
	type ObjectUrlDouble,
} from '../helpers/mediaMocks';
import { defined } from '../helpers/assertions';

describe('probeMediaDurationSeconds', () => {
	let audioMock: InstalledMock<AudioElementDouble>;

	beforeEach(() => {
		jest.useFakeTimers();
		audioMock = installAudioElementMock();
	});

	afterEach(() => {
		jest.useRealTimers();
		audioMock.restore();
	});

	/** The element the probe just constructed. */
	function element(): AudioElementDouble {
		return defined(audioMock.instances.at(-1), 'audio element');
	}

	it('takes the length the container carries without seeking', async () => {
		const probed = probeMediaDurationSeconds('app://talk.m4a');
		const audio = element();
		expect(audio.preload).toBe('metadata');
		expect(audio.src).toBe('app://talk.m4a');

		audio.duration = 125.5;
		audio.emit('loadedmetadata');

		expect(await probed).toBe(125.5);
		// A container that answered needs no seek: the far one is a manoeuvre,
		// not a step.
		expect(audio.seekedTo).toBeNull();
	});

	it('seeks past the end when the metadata carries no length, then takes the corrected one', async () => {
		const probed = probeMediaDurationSeconds('app://talk.webm');
		const audio = element();

		// What a MediaRecorder stream reports: a track, but no length.
		audio.duration = Number.POSITIVE_INFINITY;
		audio.emit('loadedmetadata');
		expect(audio.seekedTo).toBe(DURATION_PROBE_SECONDS);

		audio.duration = 3600;
		audio.emit('durationchange');

		expect(await probed).toBe(3600);
	});

	it('treats a finite zero as no length either', async () => {
		const probed = probeMediaDurationSeconds('app://talk.mp4');
		const audio = element();

		// A container whose length was never stamped loads at a usable-looking
		// zero; taking it would price a recording as costing nothing.
		audio.duration = 0;
		audio.emit('loadedmetadata');
		expect(audio.seekedTo).toBe(DURATION_PROBE_SECONDS);

		audio.duration = 42;
		audio.emit('durationchange');

		expect(await probed).toBe(42);
	});

	it('keeps waiting through a durationchange that still carries nothing', async () => {
		const probed = probeMediaDurationSeconds('app://talk.webm');
		const audio = element();
		audio.duration = Number.POSITIVE_INFINITY;
		audio.emit('loadedmetadata');

		// The browser announces the seek before it has read the last packet;
		// settling on that would lock in the value the seek was meant to fix.
		audio.emit('durationchange');
		audio.duration = 90;
		audio.emit('durationchange');

		expect(await probed).toBe(90);
	});

	it('answers null when the element reports an error', async () => {
		const probed = probeMediaDurationSeconds('app://broken.webm');
		element().emit('error');

		expect(await probed).toBeNull();
	});

	it('answers null when the seek is refused', async () => {
		const probed = probeMediaDurationSeconds('app://locked.webm');
		const audio = element();
		audio.seekRejects = true;
		audio.duration = Number.POSITIVE_INFINITY;
		audio.emit('loadedmetadata');

		// There is no second way to ask, so the probe ends rather than waiting
		// for a durationchange the refused seek will never produce.
		expect(await probed).toBeNull();
	});

	it('gives up on a load that never answers', async () => {
		const probed = probeMediaDurationSeconds('app://stalled.webm');

		jest.advanceTimersByTime(15000);

		// Without the watchdog every caller of this would hang on one bad file.
		expect(await probed).toBeNull();
	});

	it('releases the source and every listener however it ends', async () => {
		const resolved = probeMediaDurationSeconds('app://talk.webm');
		const first = element();
		first.duration = 10;
		first.emit('loadedmetadata');
		await resolved;

		const failed = probeMediaDurationSeconds('app://broken.webm');
		const second = element();
		second.emit('error');
		await failed;

		for (const audio of [first, second]) {
			expect(audio.released).toBe(true);
			expect(audio.attachedListenerCount).toBe(0);
		}
	});

	it('settles once, so a late event cannot answer a second time', async () => {
		const probed = probeMediaDurationSeconds('app://talk.webm');
		const audio = element();
		audio.duration = 10;
		audio.emit('loadedmetadata');
		expect(await probed).toBe(10);

		// The element is detached but a queued event could still arrive; the
		// promise is already settled, so this must be inert rather than a throw.
		audio.duration = 999;
		expect(() => {
			audio.emit('durationchange');
		}).not.toThrow();
		expect(await probed).toBe(10);
	});
});

describe('probeBlobDurationSeconds', () => {
	let audioMock: InstalledMock<AudioElementDouble>;
	let urlMock: InstalledMock<ObjectUrlDouble>;

	beforeEach(() => {
		jest.useFakeTimers();
		audioMock = installAudioElementMock();
		urlMock = installObjectUrlMock();
	});

	afterEach(() => {
		jest.useRealTimers();
		urlMock.restore();
		audioMock.restore();
	});

	/** The URL bookkeeping for the current test. */
	function urls(): ObjectUrlDouble {
		return defined(urlMock.instances[0], 'object url record');
	}

	it('reads bytes a caller already holds and releases the URL it made', async () => {
		const probed = probeBlobDurationSeconds(
			new ArrayBuffer(8),
			'audio/webm',
		);
		const audio = defined(audioMock.instances.at(-1), 'audio element');
		expect(audio.src).toBe(urls().created[0]);

		audio.duration = 77;
		audio.emit('loadedmetadata');

		expect(await probed).toBe(77);
		expect(urls().revoked).toEqual(urls().created);
	});

	it('releases the URL when the read fails too', async () => {
		const probed = probeBlobDurationSeconds(
			new ArrayBuffer(8),
			'audio/webm',
		);
		defined(audioMock.instances.at(-1), 'audio element').emit('error');

		expect(await probed).toBeNull();
		// A blob URL pins its data for the life of the document, so a probe
		// that leaked one per failed file would hold every one of them.
		expect(urls().revoked).toEqual(urls().created);
	});
});

describe('usableSeconds', () => {
	it('takes a real length', () => {
		expect(usableSeconds(90)).toBe(90);
		expect(usableSeconds(0.25)).toBe(0.25);
	});

	it.each([
		['a streamed container before the seek', Number.POSITIVE_INFINITY],
		['a length that was never stamped', 0],
		['a reader that answered nothing at all', Number.NaN],
		['a value no timeline could hold', -1],
	])('reads %s as no length rather than as one', (_case, reported) => {
		// The one rule every source of a length goes through: a media element,
		// a container parse, and a decode all report "nothing was read" in their
		// own way, and a reader that cannot tell those from a measurement is the
		// one that prices a recording it knows nothing about at zero.
		expect(usableSeconds(reported)).toBeNull();
	});
});
