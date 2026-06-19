/**
 * Probes whether a media file is audio-only, carries video, or cannot be
 * played, by loading its metadata into a detached <video> element. The
 * enhanced player only takes over audio-only files; video and unplayable
 * files are left to Obsidian's built-in embed so video can be watched and
 * unsupported formats degrade gracefully.
 * @module player/mediaProbe
 */

/** Classification of a media file for takeover decisions. */
export type MediaKind = 'audio' | 'video' | 'unsupported';

/** How long to wait for metadata before assuming a plain audio file. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Loads a media resource's metadata to classify it. A video track (non
 * zero dimensions) marks it as video; metadata without video is audio; a
 * load error is unsupported. Resolves to audio if metadata never arrives,
 * so a slow probe still yields the enhanced player.
 * @param resourceUrl - Resource URL from app.vault.getResourcePath
 */
export function probeMediaKind(resourceUrl: string): Promise<MediaKind> {
	return new Promise((resolve) => {
		const el = activeDocument.createElement('video');
		el.preload = 'metadata';
		el.muted = true;
		let settled = false;
		let timer = 0;
		const settle = (kind: MediaKind): void => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timer);
			// Release the probe element's decoder
			el.removeAttribute('src');
			el.load();
			resolve(kind);
		};
		el.addEventListener(
			'loadedmetadata',
			() => {
				settle(
					el.videoWidth > 0 && el.videoHeight > 0 ? 'video' : 'audio',
				);
			},
			{ once: true },
		);
		el.addEventListener(
			'error',
			() => {
				settle('unsupported');
			},
			{ once: true },
		);
		timer = window.setTimeout(() => {
			settle('audio');
		}, PROBE_TIMEOUT_MS);
		el.src = resourceUrl;
	});
}
