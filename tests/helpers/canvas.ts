/**
 * A 2D canvas context for jsdom, which has none.
 *
 * `HTMLCanvasElement.getContext` throws "Not implemented" in jsdom unless the
 * native `canvas` package is installed, and the waveform renderer calls it on
 * every draw. Without a stand-in, a waveform test either avoids drawing - which
 * is the part worth testing - or fills the run with jsdom's error output.
 *
 * The double records what was drawn, so a test can ask how many bars were
 * painted and how wide they were rather than only that nothing threw.
 * @module tests/helpers/canvas
 */

/** One filled rectangle recorded by the context double. */
export interface RecordedRect {
	x: number;
	y: number;
	width: number;
	height: number;
	fillStyle: string;
}

/** The recording context, plus what it was asked to draw. */
export interface CanvasContextDouble {
	/** Rectangles filled since the last clear, in order. */
	rects: RecordedRect[];
	/** How many times the canvas was cleared. */
	clears: number;
	/** Restores the original getContext. */
	restore: () => void;
}

/**
 * Installs a recording 2D context on every canvas for the current test.
 * @returns The recorder, with a restore() the caller runs in afterEach
 */
export function installCanvas2dContext(): CanvasContextDouble {
	const original = HTMLCanvasElement.prototype.getContext;
	const recorder: CanvasContextDouble = {
		rects: [],
		clears: 0,
		restore: () => {
			HTMLCanvasElement.prototype.getContext = original;
		},
	};

	const context = {
		fillStyle: '',
		clearRect: jest.fn(() => {
			recorder.clears += 1;
			recorder.rects.length = 0;
		}),
		fillRect: jest.fn(
			(x: number, y: number, width: number, height: number) => {
				recorder.rects.push({
					x,
					y,
					width,
					height,
					fillStyle: context.fillStyle,
				});
			},
		),
		scale: jest.fn(),
		setTransform: jest.fn(),
		save: jest.fn(),
		restore: jest.fn(),
		beginPath: jest.fn(),
		closePath: jest.fn(),
		fill: jest.fn(),
		rect: jest.fn(),
		roundRect: jest.fn(),
		moveTo: jest.fn(),
		lineTo: jest.fn(),
		stroke: jest.fn(),
	};

	HTMLCanvasElement.prototype.getContext = jest.fn((kind: string) =>
		kind === '2d' ? context : null,
	) as unknown as typeof original;

	return recorder;
}
