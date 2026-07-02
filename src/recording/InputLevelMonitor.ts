/**
 * Live input-level metering. Taps a MediaStream through a Web Audio
 * AnalyserNode and exposes a 0..1 level for a VU meter. The RMS and
 * perceptual-scaling math is pure and unit tested; the class wraps it
 * with the audio-graph plumbing and resource cleanup.
 * @module recording/InputLevelMonitor
 */

import { PLUGIN_LOG_PREFIX } from '../constants';

/** Lowest level, in dBFS, mapped to the bottom of the meter. */
const METER_FLOOR_DB = -60;

/**
 * Root-mean-square amplitude of time-domain samples (range 0..~1).
 * @param samples - Time-domain samples in the range -1..1
 */
export function computeRms(samples: Float32Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sumSquares = 0;
	for (let i = 0; i < samples.length; i++) {
		sumSquares += samples[i] * samples[i];
	}
	return Math.sqrt(sumSquares / samples.length);
}

/**
 * Maps an RMS amplitude to a 0..1 meter fraction on a dB scale, so quiet
 * speech is visible and the meter behaves perceptually. Silence maps to
 * 0; full scale maps to 1.
 * @param rms - RMS amplitude (0..1)
 */
export function rmsToMeterFraction(rms: number): number {
	if (rms <= 0) {
		return 0;
	}
	const db = 20 * Math.log10(rms);
	const fraction = (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
	return Math.min(1, Math.max(0, fraction));
}

/**
 * Wraps a MediaStream in an analyser to read the live input level.
 */
export class InputLevelMonitor {
	private context: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private buffer: Float32Array<ArrayBuffer> | null = null;

	/**
	 * Starts metering the given stream. Safe to call once per monitor.
	 * @param stream - Input MediaStream to meter
	 */
	start(stream: MediaStream): void {
		try {
			this.context = new AudioContext();
			// A context may start suspended until a user gesture; resume so
			// the analyser receives data instead of reading silence.
			if (this.context.state === 'suspended') {
				void this.context.resume().catch(() => {
					// Non-fatal: the meter simply stays at zero
				});
			}
			this.source = this.context.createMediaStreamSource(stream);
			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = 1024;
			// Analyser only - never connect to the destination, or the
			// input would be played back as a feedback loop.
			this.source.connect(this.analyser);
			this.buffer = new Float32Array(this.analyser.fftSize);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not start input level monitor:`,
				error,
			);
			this.stop();
		}
	}

	/**
	 * Returns the current input level as a 0..1 meter fraction, or 0 when
	 * the monitor is not running.
	 */
	getLevel(): number {
		if (!this.analyser || !this.buffer) {
			return 0;
		}
		this.analyser.getFloatTimeDomainData(this.buffer);
		return rmsToMeterFraction(computeRms(this.buffer));
	}

	/**
	 * Stops metering and releases the audio graph.
	 */
	stop(): void {
		try {
			this.source?.disconnect();
		} catch {
			// Already disconnected
		}
		if (this.context) {
			void this.context.close().catch(() => {
				// Closing a context that already failed is non-fatal
			});
		}
		this.context = null;
		this.analyser = null;
		this.source = null;
		this.buffer = null;
	}
}
