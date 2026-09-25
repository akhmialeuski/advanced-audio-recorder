/**
 * The browser surface an in-memory capture runs on: a microphone that hands
 * out one stream, and a MediaRecorder that delivers a chunk when it stops.
 *
 * Shared by the recorder's own unit suite and by the quick note suite, which
 * drives the same recorder end to end, so both describe the browser the same
 * way.
 * @module tests/helpers/memoryCapture
 */

import { globals, partial } from './doubles';

/** MediaRecorder double that emits one chunk and stops synchronously. */
export class ChunkingMediaRecorder {
	static instances: ChunkingMediaRecorder[] = [];
	static isTypeSupported = jest.fn().mockReturnValue(true);
	/** What the next recorder delivers when it stops. */
	static nextChunk = 'chunk';
	state = 'recording';
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	private stopHandler: (() => void) | null = null;

	constructor(
		public readonly stream: MediaStream,
		public readonly options: unknown,
	) {
		ChunkingMediaRecorder.instances.push(this);
	}

	start(): void {
		this.state = 'recording';
	}

	stop(): void {
		this.state = 'inactive';
		this.ondataavailable?.({
			data: new Blob([ChunkingMediaRecorder.nextChunk]),
		});
		this.stopHandler?.();
	}

	addEventListener(event: string, handler: () => void): void {
		if (event === 'stop') {
			this.stopHandler = handler;
		}
	}
}

/** The microphone a test installed, and the spies that observe it. */
export interface InstalledMicrophone {
	/** The stream every getUserMedia call resolves with. */
	stream: MediaStream;
	/** Called when the capture releases the stream's track. */
	trackStop: jest.Mock;
	/** The getUserMedia double, for asserting whether the device was opened. */
	getUserMedia: jest.Mock;
}

/**
 * What installMicrophone replaced, or null when nothing is installed. Kept so
 * the per-test reset in tests/setupAfterEnv.ts can put it back: a test that
 * ran after an install used to find the double still in place, so what it
 * exercised, and what the coverage guard measured, turned on the order the
 * cases ran in.
 */
let replaced: { mediaRecorder: unknown; mediaDevices: unknown } | null = null;

/**
 * Installs the recorder double and a microphone that always grants access,
 * for the current test only.
 * @returns The microphone and its spies
 */
export function installMicrophone(): InstalledMicrophone {
	replaced ??= {
		mediaRecorder: globals().MediaRecorder,
		mediaDevices: (global.navigator as { mediaDevices?: unknown })
			.mediaDevices,
	};
	ChunkingMediaRecorder.instances = [];
	ChunkingMediaRecorder.nextChunk = 'chunk';
	ChunkingMediaRecorder.isTypeSupported.mockReturnValue(true);
	globals().MediaRecorder = ChunkingMediaRecorder;
	const trackStop = jest.fn();
	const stream = partial<MediaStream>({
		getTracks: () => [{ stop: trackStop }],
	});
	const getUserMedia = jest.fn().mockResolvedValue(stream);
	(global.navigator as { mediaDevices?: unknown }).mediaDevices = {
		getUserMedia,
	};
	return { stream, trackStop, getUserMedia };
}

/**
 * Puts back whatever installMicrophone replaced. Run before every test from
 * tests/setupAfterEnv.ts, so a case starts without the double unless it
 * installs one itself, whatever ran before it.
 */
export function __resetMicrophone(): void {
	if (!replaced) {
		return;
	}
	const navigatorGlobals = global.navigator as { mediaDevices?: unknown };
	if (replaced.mediaRecorder === undefined) {
		delete globals().MediaRecorder;
	} else {
		globals().MediaRecorder = replaced.mediaRecorder;
	}
	if (replaced.mediaDevices === undefined) {
		delete navigatorGlobals.mediaDevices;
	} else {
		navigatorGlobals.mediaDevices = replaced.mediaDevices;
	}
	replaced = null;
}
