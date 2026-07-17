/**
 * Probes whether a media file is audio-only, carries video, or cannot be
 * played, by loading its metadata into a detached <video> element. The
 * enhanced player only takes over audio-only files; video and unplayable
 * files are left to Obsidian's built-in embed so video can be watched and
 * unsupported formats degrade gracefully.
 * @module player/mediaProbe
 */

/**
 * The media classifications the probe can return, as named constants so
 * call sites reference MEDIA_KIND.audio instead of repeating the literal.
 */
export const MEDIA_KIND = {
	audio: 'audio',
	video: 'video',
	unsupported: 'unsupported',
} as const;

/** Classification of a media file for takeover decisions. */
export type MediaKind = (typeof MEDIA_KIND)[keyof typeof MEDIA_KIND];

/** How long to wait for metadata before assuming a plain audio file. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * A probe's classification plus whether it came from real metadata.
 * A timeout fallback is usable for this session but must not be
 * persisted, or a slow-loading video would stay misclassified as audio
 * across sessions.
 */
export interface MediaProbeResult {
	/** The media classification. */
	kind: MediaKind;
	/** True when derived from metadata/error, false on the timeout fallback. */
	confident: boolean;
}

/**
 * Loads a media resource's metadata to classify it. A video track (non
 * zero dimensions) marks it as video; metadata without video is audio; a
 * load error is unsupported. Resolves to audio if metadata never arrives,
 * so a slow probe still yields the enhanced player - but flagged as not
 * confident, so the fallback is never persisted as the file's true kind.
 * @param resourceUrl - Resource URL from app.vault.getResourcePath
 */
export function probeMediaKind(resourceUrl: string): Promise<MediaProbeResult> {
	return new Promise((resolve) => {
		const el = createEl('video');
		el.preload = 'metadata';
		el.muted = true;
		let settled = false;
		let timer = 0;
		const settle = (kind: MediaKind, confident: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timer);
			// Release the probe element's decoder
			el.removeAttribute('src');
			el.load();
			resolve({ kind, confident });
		};
		el.addEventListener(
			'loadedmetadata',
			() => {
				settle(
					el.videoWidth > 0 && el.videoHeight > 0
						? MEDIA_KIND.video
						: MEDIA_KIND.audio,
					true,
				);
			},
			{ once: true },
		);
		el.addEventListener(
			'error',
			() => {
				settle(MEDIA_KIND.unsupported, true);
			},
			{ once: true },
		);
		timer = window.setTimeout(() => {
			settle(MEDIA_KIND.audio, false);
		}, PROBE_TIMEOUT_MS);
		el.src = resourceUrl;
	});
}
