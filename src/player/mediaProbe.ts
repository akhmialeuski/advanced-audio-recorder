/**
 * Probes whether a media file is audio-only, carries video, or cannot be
 * played. The enhanced player only takes over audio-only files; video and
 * unplayable files are left to Obsidian's built-in embed so video can be
 * watched and unsupported formats degrade gracefully.
 *
 * The container's own track list answers first, read by range from its
 * headers; a detached <video> element loading the file's metadata answers
 * where the headers could not.
 * @module player/mediaProbe
 */

import { resourceSource, withMediaInput } from '../audio/mediaInput';

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

/**
 * How long either reader may take before it is given up on: the header read
 * before the element is tried, and the element before a plain audio file is
 * assumed.
 */
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
 * Classifies a media resource, from its container's track list where that
 * parses and from a media element's metadata where it does not. Resolves to
 * audio if neither answers in time, so a slow probe still yields the enhanced
 * player - but flagged as not confident, so the fallback is never persisted as
 * the file's true kind.
 * @param resourceUrl - Resource URL from app.vault.getResourcePath
 */
export async function probeMediaKind(
	resourceUrl: string,
): Promise<MediaProbeResult> {
	return (
		(await classifyFromHeaders(resourceUrl)) ??
		(await probeWithElement(resourceUrl))
	);
}

/**
 * The answer the container's headers give, or null where they give none this
 * probe can stand on.
 *
 * The headers settle the question the element could only infer: whether a
 * video track exists, not whether a frame happened to have dimensions by the
 * time metadata arrived, and they settle it without a decoder and without the
 * timeout. An audio-only container is taken as audio only where the browser
 * also says it can play that type, because the enhanced player is an audio
 * element and a confident answer is kept for good; a type it does not
 * recognise, and every container the headers could not be read from, is left
 * to the element, which tries the file for real.
 * @param resourceUrl - Resource URL of the file
 * @returns The classification, or null to ask the element instead
 */
async function classifyFromHeaders(
	resourceUrl: string,
): Promise<MediaProbeResult | null> {
	let timer = 0;
	try {
		return await withMediaInput(resourceSource(resourceUrl), (input) =>
			Promise.race([
				(async (): Promise<MediaProbeResult | null> => {
					if ((await input.getVideoTracks()).length > 0) {
						return { kind: MEDIA_KIND.video, confident: true };
					}
					if (!(await input.getPrimaryAudioTrack())) {
						return null;
					}
					return canPlayType(await input.getMimeType())
						? { kind: MEDIA_KIND.audio, confident: true }
						: null;
				})(),
				new Promise<null>((resolve) => {
					// The read is abandoned rather than waited on: leaving
					// the scope disposes the input, which cancels it.
					timer = window.setTimeout(() => {
						resolve(null);
					}, PROBE_TIMEOUT_MS);
				}),
			]),
		);
	} catch {
		// Not a container mediabunny reads, or a read that failed: the
		// element is the reader for those.
		return null;
	} finally {
		window.clearTimeout(timer);
	}
}

/**
 * Whether the browser says it can play a media type at all.
 * @param mimeType - The container's full type, codec parameters included
 */
function canPlayType(mimeType: string): boolean {
	return createEl('audio').canPlayType(mimeType) !== '';
}

/**
 * Loads a media resource's metadata into a detached <video> element to
 * classify it. A video track (non-zero dimensions) marks it as video;
 * metadata without video is audio; a load error is unsupported. Resolves
 * to audio, not confident, if metadata never arrives.
 * @param resourceUrl - Resource URL of the file
 */
function probeWithElement(resourceUrl: string): Promise<MediaProbeResult> {
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
