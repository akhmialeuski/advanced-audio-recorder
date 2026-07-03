/**
 * Presentation copy for audio formats: the encoder description shown in
 * the settings tab and the conversion dialog. Kept in the UI layer so the
 * audio/codec layer carries no display strings.
 * @module ui/formatDescriptions
 */

import {
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
	FORMAT_FLAC,
} from '../constants';
import type { AudioFormatId } from '../audio/formatRegistry';

/** Encoder description per format id. */
const ENCODER_DESCRIPTIONS: Record<AudioFormatId, string> = {
	[FORMAT_WAV]: 'PCM (built-in)',
	[FORMAT_WEBM]: 'AudioEncoder (Opus) + Mediabunny',
	[FORMAT_OGG]: 'AudioEncoder (Opus) + Mediabunny',
	[FORMAT_MP3]: 'Mediabunny MP3 Encoder',
	[FORMAT_M4A]: 'AudioEncoder (AAC) + Mediabunny',
	[FORMAT_MP4]: 'AudioEncoder (AAC) + Mediabunny',
	[FORMAT_FLAC]: 'Mediabunny FLAC Encoder',
	[FORMAT_AAC]: 'AudioEncoder (AAC) + Mediabunny',
};

/**
 * Returns a human-readable description of the encoder used for the format.
 * @param format - Audio format id
 * @returns Encoder description string
 */
export function getEncoderDescription(format: string): string {
	return (
		(ENCODER_DESCRIPTIONS as Record<string, string>)[format] ?? 'Unknown'
	);
}
