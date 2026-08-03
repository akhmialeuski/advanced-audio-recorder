/**
 * How long a recording is, read through the browser's own media pipeline.
 *
 * A container that carries its length in the header is answered by the cheap
 * probe in {@link module:utils/AudioFileAnalyzer}. What is left is the case
 * this plugin produces itself: a recorder streaming into a container stamps no
 * length into a segment it has not finished, so the headers say nothing and the
 * only readers left are the ones that look at the packets.
 *
 * Expanding the file to PCM is one such reader, and the expensive one - a
 * two-hour recording becomes gigabytes of samples to learn a single number. The
 * browser is the other, and it is the same engine that wrote the file: loading
 * only the metadata costs no samples at all, and seeking past the end makes it
 * read on to the last packet and announce the real length. The enhanced player
 * has always resolved its seek bar that way; this is that manoeuvre on a
 * detached element, so a caller that merely needs the number does not have to
 * be playing the file to get it.
 * @module utils/mediaDuration
 */

/**
 * A far seek position that makes a browser compute a length its container does
 * not carry. Seeking there reports a `durationchange` with the real value,
 * which is the only way to get one out of a MediaRecorder stream.
 */
export const DURATION_PROBE_SECONDS = 1e101;

/**
 * How long to wait for a media element to report a usable length before giving
 * up. A probe that never answers must not hang the run that asked, so every
 * caller gets null instead and falls back to whatever it does without a length.
 */
const DURATION_PROBE_TIMEOUT_MS = 15000;

/**
 * The element's length, or null while it has none to give. Infinity is what a
 * streamed container reports before the seek, and a finite zero is what a
 * container whose length was never stamped reports after loading; neither is a
 * duration, so both read as "not yet".
 * @param audio - The element being probed
 */
function usableDuration(audio: HTMLAudioElement): number | null {
	return Number.isFinite(audio.duration) && audio.duration > 0
		? audio.duration
		: null;
}

/**
 * Reads a media resource's duration without decoding it.
 *
 * Loads metadata only; where that already carries the length the probe is over
 * at once. Where it does not, the far seek asks the browser to read on to the
 * last packet, and the `durationchange` it answers with is the real length.
 * Errors and a stalled load both resolve null rather than reject, because every
 * caller has something to do without a duration and none of them has anything
 * to do with the failure.
 * @param url - Resource URL of the recording
 * @returns Its length in seconds, or null when the browser could not read one
 */
export function probeMediaDurationSeconds(url: string): Promise<number | null> {
	return new Promise((resolve) => {
		const audio = new Audio();
		audio.preload = 'metadata';
		let settled = false;
		let timer = 0;
		const finish = (value: number | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timer);
			audio.removeEventListener('loadedmetadata', onMetadata);
			audio.removeEventListener('durationchange', onDurationChange);
			audio.removeEventListener('error', onError);
			// Release the source and the decoder the element holds; a detached
			// element is not collected while it still has one loaded.
			audio.removeAttribute('src');
			audio.load();
			resolve(value);
		};
		const onMetadata = (): void => {
			const known = usableDuration(audio);
			if (known !== null) {
				finish(known);
				return;
			}
			try {
				audio.currentTime = DURATION_PROBE_SECONDS;
			} catch {
				// Some sources refuse the seek; there is no second way to ask.
				finish(null);
			}
		};
		const onDurationChange = (): void => {
			const resolved = usableDuration(audio);
			if (resolved !== null) {
				finish(resolved);
			}
		};
		const onError = (): void => {
			finish(null);
		};
		audio.addEventListener('loadedmetadata', onMetadata);
		audio.addEventListener('durationchange', onDurationChange);
		audio.addEventListener('error', onError);
		timer = window.setTimeout(() => {
			finish(null);
		}, DURATION_PROBE_TIMEOUT_MS);
		audio.src = url;
	});
}

/**
 * The same read for bytes a caller already holds, which is what the transcribe
 * dialog and the file-info action have: the blob is given the file's own MIME
 * type so the browser picks the demuxer rather than sniffing, and its URL is
 * released whatever the probe answers.
 * @param data - The file's bytes
 * @param mimeType - MIME type of the container those bytes are in
 * @returns Its length in seconds, or null when the browser could not read one
 */
export async function probeBlobDurationSeconds(
	data: ArrayBuffer,
	mimeType: string,
): Promise<number | null> {
	const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
	try {
		return await probeMediaDurationSeconds(url);
	} finally {
		URL.revokeObjectURL(url);
	}
}
