/**
 * A stretch of a recording drawn as a bar, with two handles that pick a span
 * inside it and a playhead that follows a preview of that span. The split
 * dialog lays it over the line being split, so where the selection starts and
 * ends is dragged into place while listening instead of typed as a timecode.
 *
 * The handles are two native range inputs stacked on one track, the usual way
 * to build a two-handle slider without a library: each keeps keyboard and
 * touch handling, focus and its accessible name, and only its thumb takes the
 * pointer, so either handle can be grabbed wherever the other one sits.
 * @module ui/TimeSpanSlider
 */

import type { SpeakerPreviewRange } from '../speakers/speakerPreview';
import { formatLineTime } from '../speakers/transcriptRows';

/** Seconds one step of a handle moves, matching the tenths the fields show. */
const HANDLE_STEP_SECONDS = 0.1;

/** What the slider needs from the dialog that shows it. */
export interface TimeSpanSliderOptions {
	/** The stretch the bar covers. */
	bounds: SpeakerPreviewRange;
	/** The span the handles start at. */
	value: SpeakerPreviewRange;
	/** Called while a handle is dragged, with the span it now marks. */
	onInput: (span: SpeakerPreviewRange) => void;
	/** Called when a handle is let go, with the span it was left at. */
	onChange: (span: SpeakerPreviewRange) => void;
}

/**
 * Two-handle slider over a time span, with a playhead.
 */
export class TimeSpanSlider {
	private readonly el: HTMLElement;
	private readonly startInput: HTMLInputElement;
	private readonly endInput: HTMLInputElement;

	/**
	 * Builds the slider at the end of a container.
	 * @param container - Element the slider is appended to
	 * @param options - Bounds, starting span and callbacks
	 */
	constructor(
		container: HTMLElement,
		private readonly options: TimeSpanSliderOptions,
	) {
		const { bounds } = options;
		this.el = container.createDiv({ cls: 'aar-time-span' });
		const bar = this.el.createDiv({ cls: 'aar-time-span-bar' });
		bar.createDiv({ cls: 'aar-time-span-track' });
		bar.createDiv({ cls: 'aar-time-span-fill' });
		bar.createDiv({ cls: 'aar-time-span-playhead' });
		const handle = (label: string): HTMLInputElement =>
			bar.createEl('input', {
				cls: 'aar-time-span-handle',
				attr: {
					type: 'range',
					min: String(bounds.start),
					max: String(bounds.end),
					step: String(HANDLE_STEP_SECONDS),
					'aria-label': label,
				},
			});
		this.startInput = handle('Selection start');
		this.endInput = handle('Selection end');
		const scale = this.el.createDiv({ cls: 'aar-time-span-scale' });
		scale.createSpan({ text: formatLineTime(bounds.start) });
		scale.createSpan({ text: formatLineTime(bounds.end) });

		this.startInput.addEventListener('input', () => {
			this.onHandleInput(this.startInput);
		});
		this.endInput.addEventListener('input', () => {
			this.onHandleInput(this.endInput);
		});
		const release = (): void => {
			this.options.onChange(this.span());
		};
		this.startInput.addEventListener('change', release);
		this.endInput.addEventListener('change', release);

		this.setSpan(options.value);
		this.setPlayhead(null);
	}

	/**
	 * Moves the handles to a span, as when it was typed into the fields. A
	 * span reaching past the bar is shown clamped to it.
	 * @param span - The span to show
	 */
	setSpan(span: SpeakerPreviewRange): void {
		this.startInput.value = String(span.start);
		this.endInput.value = String(span.end);
		this.paint();
	}

	/**
	 * Shows the playhead at a position of the recording, or hides it.
	 * @param seconds - The position, or null when nothing is playing
	 */
	setPlayhead(seconds: number | null): void {
		this.el.toggleClass('is-playing', seconds !== null);
		if (seconds !== null) {
			this.el.setCssProps({
				'--aar-time-span-playhead': this.percent(seconds),
			});
		}
	}

	/**
	 * Keeps the dragged handle from passing the other one, then repaints and
	 * reports the span.
	 * @param moved - The handle being dragged
	 */
	private onHandleInput(moved: HTMLInputElement): void {
		const start = Number(this.startInput.value);
		const end = Number(this.endInput.value);
		if (start > end) {
			moved.value = String(moved === this.startInput ? end : start);
		}
		this.paint();
		this.options.onInput(this.span());
	}

	/** The span the handles mark. */
	private span(): SpeakerPreviewRange {
		return {
			start: Number(this.startInput.value),
			end: Number(this.endInput.value),
		};
	}

	/**
	 * Draws the stretch between the handles. The end handle lies above the
	 * start one, so once the start passes the middle of the bar it is raised
	 * instead: two handles pushed together at the far end could otherwise
	 * never be pulled apart, since the end handle cannot move left past it.
	 */
	private paint(): void {
		const { start, end } = this.span();
		const { bounds } = this.options;
		this.startInput.toggleClass(
			'is-raised',
			start > (bounds.start + bounds.end) / 2,
		);
		this.el.setCssProps({
			'--aar-time-span-start': this.percent(start),
			'--aar-time-span-end': this.percent(end),
		});
	}

	/**
	 * Where a position sits along the bar, as a CSS percentage clamped to it.
	 * @param seconds - A position of the recording
	 */
	private percent(seconds: number): string {
		const { start, end } = this.options.bounds;
		const ratio = (seconds - start) / (end - start);
		return `${String(Math.min(Math.max(ratio, 0), 1) * 100)}%`;
	}
}
