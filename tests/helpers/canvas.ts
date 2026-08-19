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
 *
 * Draws are recorded twice: once into a run-wide list, and once per canvas.
 * A test that asserts something was *not* drawn needs the per-canvas view -
 * the run-wide list also catches a decode left in flight by an earlier test,
 * which lands on whichever recorder happens to be installed at the time.
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
	/** Rectangles filled on any canvas since the last clear, in order. */
	rects: RecordedRect[];
	/** How many times a canvas was cleared. */
	clears: number;
	/**
	 * Rectangles filled on one canvas, ignoring every other canvas in the run.
	 * @param target - The canvas, or an element containing exactly one
	 * @returns Its rectangles in draw order, empty when it never drew
	 */
	rectsOf: (target: HTMLElement) => RecordedRect[];
	/** Restores the original getContext. */
	restore: () => void;
}

/**
 * Installs a recording 2D context on every canvas for the current test.
 * @returns The recorder, with a restore() the caller runs in afterEach
 */
export function installCanvas2dContext(): CanvasContextDouble {
	const original = HTMLCanvasElement.prototype.getContext;
	const perCanvas = new WeakMap<HTMLCanvasElement, RecordedRect[]>();
	const recorder: CanvasContextDouble = {
		rects: [],
		clears: 0,
		rectsOf: (target) => perCanvas.get(canvasIn(target)) ?? [],
		restore: () => {
			HTMLCanvasElement.prototype.getContext = original;
		},
	};

	/** Builds the recording context one canvas draws through. */
	function contextFor(canvas: HTMLCanvasElement): object {
		const own: RecordedRect[] = [];
		perCanvas.set(canvas, own);
		const context = {
			fillStyle: '',
			clearRect: jest.fn(() => {
				recorder.clears += 1;
				recorder.rects.length = 0;
				own.length = 0;
			}),
			fillRect: jest.fn(
				(x: number, y: number, width: number, height: number) => {
					const rect = {
						x,
						y,
						width,
						height,
						fillStyle: context.fillStyle,
					};
					recorder.rects.push(rect);
					own.push(rect);
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
		return context;
	}

	const contexts = new WeakMap<HTMLCanvasElement, object>();
	HTMLCanvasElement.prototype.getContext = jest.fn(function (
		this: HTMLCanvasElement,
		kind: string,
	) {
		if (kind !== '2d') {
			return null;
		}
		const existing = contexts.get(this);
		if (existing) {
			return existing;
		}
		const created = contextFor(this);
		contexts.set(this, created);
		return created;
	}) as unknown as typeof original;

	return recorder;
}

/**
 * Resolves the canvas a test means: itself, or the one it contains.
 * @param target - A canvas, or an element holding exactly one
 * @returns The canvas
 */
function canvasIn(target: HTMLElement): HTMLCanvasElement {
	if (target instanceof HTMLCanvasElement) {
		return target;
	}
	const found = target.querySelector('canvas');
	if (!found) {
		throw new Error('No canvas inside the given element');
	}
	return found;
}
