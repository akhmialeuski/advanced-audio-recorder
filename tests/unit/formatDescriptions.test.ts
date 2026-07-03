/**
 * Unit tests for the UI-layer format description lookup.
 * @module tests/unit/formatDescriptions.test
 */

import { getEncoderDescription } from 'src/ui/formatDescriptions';

describe('getEncoderDescription', () => {
	it.each([
		['wav', 'PCM (built-in)'],
		['webm', 'AudioEncoder (Opus) + Mediabunny'],
		['ogg', 'AudioEncoder (Opus) + Mediabunny'],
		['mp4', 'AudioEncoder (AAC) + Mediabunny'],
		['m4a', 'AudioEncoder (AAC) + Mediabunny'],
		['aac', 'AudioEncoder (AAC) + Mediabunny'],
		['mp3', 'Mediabunny MP3 Encoder'],
		['flac', 'Mediabunny FLAC Encoder'],
	])('describes %s as %s', (format, description) => {
		expect(getEncoderDescription(format)).toBe(description);
	});

	it('returns Unknown for unsupported formats', () => {
		expect(getEncoderDescription('xyz')).toBe('Unknown');
	});
});
