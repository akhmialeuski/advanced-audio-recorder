/**
 * Tests the transcription dictionary parser. The dictionary is one term per
 * line so a term may contain spaces; the parser trims each line, drops blanks,
 * and removes case-insensitive duplicates while keeping first-seen order.
 * @module tests/unit/dictionary.test
 */

import { parseDictionary } from 'src/transcription/dictionary';

describe('parseDictionary', () => {
	it('splits on newlines and trims each term', () => {
		expect(parseDictionary('Kubernetes\n  gRPC  \nCI/CD')).toEqual([
			'Kubernetes',
			'gRPC',
			'CI/CD',
		]);
	});

	it('keeps terms that contain spaces intact', () => {
		expect(parseDictionary('Anatol Khmialeuski\nPull Request')).toEqual([
			'Anatol Khmialeuski',
			'Pull Request',
		]);
	});

	it('drops blank lines and handles CRLF endings', () => {
		expect(parseDictionary('one\r\n\r\n  \r\ntwo')).toEqual(['one', 'two']);
	});

	it('removes case-insensitive duplicates, keeping first-seen order', () => {
		expect(
			parseDictionary('Deepgram\ndeepgram\nDEEPGRAM\nWhisper'),
		).toEqual(['Deepgram', 'Whisper']);
	});

	it('returns an empty array for empty or whitespace-only input', () => {
		expect(parseDictionary('')).toEqual([]);
		expect(parseDictionary('   \n\t\n')).toEqual([]);
	});
});
