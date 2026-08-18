/**
 * Coaxing a real length out of a file that reports none.
 *
 * MediaRecorder WebM reports Infinity until it is fully read, and some
 * multitrack mp4 containers report a finite 0. Both leave the seek bar
 * unusable, so the player seeks far ahead to force the browser to compute the
 * length - and then has to put the playhead back, whatever the answer was. The
 * failure modes are the point: a length that never arrives must not strand
 * playback at the end of the file.
 * @module tests/unit/DurationProbe.test
 */

import { DurationProbe } from 'src/player/DurationProbe';
import { DURATION_PROBE_SECONDS } from 'src/utils/mediaDuration';

/** An audio element whose duration and seeks the test drives. */
function createSut(options: { seekThrows?: boolean } = {}): {
	probe: DurationProbe;
	audio: HTMLAudioElement & { duration: number; currentTime: number };
	onResolved: jest.Mock;
	reportDuration: (duration: number) => void;
} {
	let currentTime = 0;
	const listeners = new Set<() => void>();
	const audio = {
		duration: Number.POSITIVE_INFINITY,
		get currentTime(): number {
			return currentTime;
		},
		set currentTime(value: number) {
			// A source that rejects a seek rejects the far one, past its
			// seekable range; returning to the start still works, which is
			// what lets the probe give up cleanly.
			if (options.seekThrows && value > 0) {
				throw new Error('this source refuses a seek');
			}
			currentTime = value;
		},
		addEventListener: (type: string, handler: () => void): void => {
			if (type === 'durationchange') {
				listeners.add(handler);
			}
		},
		removeEventListener: (_type: string, handler: () => void): void => {
			listeners.delete(handler);
		},
	} as unknown as HTMLAudioElement & {
		duration: number;
		currentTime: number;
	};
	const onResolved = jest.fn();
	return {
		probe: new DurationProbe(audio, onResolved),
		audio,
		onResolved,
		reportDuration: (duration: number): void => {
			audio.duration = duration;
			for (const handler of [...listeners]) {
				handler();
			}
		},
	};
}

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('probing for a length', () => {
	it('seeks far ahead to force the browser to compute one', () => {
		const { probe, audio } = createSut();

		probe.probe();

		expect(audio.currentTime).toBe(DURATION_PROBE_SECONDS);
	});

	it('restores the start and reports once a real length arrives', () => {
		const { probe, audio, onResolved, reportDuration } = createSut();
		probe.probe();

		reportDuration(90);

		expect(audio.currentTime).toBe(0);
		expect(onResolved).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: 'still infinite', duration: Number.POSITIVE_INFINITY },
		{ name: 'a bogus zero', duration: 0 },
	])('keeps waiting while the length is $name', ({ duration }) => {
		// Finishing on "finite" alone would lock in the useless zero a file
		// that loaded empty reports, instead of the corrected length.
		const { probe, onResolved, reportDuration } = createSut();
		probe.probe();

		reportDuration(duration);

		expect(onResolved).not.toHaveBeenCalled();
	});

	it('gives up rather than leaving playback stranded at the end', () => {
		// Without the watchdog a file whose length never arrives keeps the
		// playhead at the probe position, so pressing play does nothing.
		const { probe, audio, onResolved } = createSut();
		probe.probe();

		jest.advanceTimersByTime(5000);

		expect(audio.currentTime).toBe(0);
		expect(onResolved).toHaveBeenCalledTimes(1);
	});

	it('gives up at once on a source that refuses the seek', () => {
		const { probe, onResolved } = createSut({ seekThrows: true });

		probe.probe();

		expect(onResolved).toHaveBeenCalledTimes(1);
	});

	it('runs one probe at a time', () => {
		// Two loadedmetadata events can arrive together; a second seek would
		// restart the watchdog and move the playhead again.
		const { probe, onResolved, reportDuration } = createSut();
		probe.probe();

		probe.probe();
		reportDuration(90);

		expect(onResolved).toHaveBeenCalledTimes(1);
	});

	it('probes again once the previous one finished', () => {
		const { probe, onResolved, reportDuration } = createSut();
		probe.probe();
		reportDuration(90);

		probe.probe();
		reportDuration(120);

		expect(onResolved).toHaveBeenCalledTimes(2);
	});
});

describe('cancelling a probe', () => {
	it('leaves the playhead where the probe put it', () => {
		// Cancel runs on unload, when the element may belong to another
		// player already; moving its position would interrupt playback.
		const { probe, audio } = createSut();
		probe.probe();

		probe.cancel();

		expect(audio.currentTime).toBe(DURATION_PROBE_SECONDS);
	});

	it('stops the watchdog, so nothing fires after the player is gone', () => {
		const { probe, onResolved } = createSut();
		probe.probe();

		probe.cancel();
		jest.advanceTimersByTime(5000);

		expect(onResolved).not.toHaveBeenCalled();
	});

	it('stops listening, so a late length change reaches nothing', () => {
		const { probe, onResolved, reportDuration } = createSut();
		probe.probe();

		probe.cancel();
		reportDuration(90);

		expect(onResolved).not.toHaveBeenCalled();
	});

	it('does nothing when no probe is running', () => {
		const { probe } = createSut();

		expect(() => {
			probe.cancel();
		}).not.toThrow();
	});
});
