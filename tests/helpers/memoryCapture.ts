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
 * Installs the recorder double and a microphone that always grants access.
 * @returns The microphone and its spies
 */
export function installMicrophone(): InstalledMicrophone {
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
