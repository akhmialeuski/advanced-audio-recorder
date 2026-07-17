/**
 * Tests for the pure speaker-name model: parsing, normalization,
 * rename-diffing, and the participant registry helpers.
 */

import {
	addParticipants,
	displaySpeaker,
	emptySpeakerNames,
	hasSpeakerData,
	parseParticipants,
	parseSpeakerNames,
	serializeSpeakerNames,
	speakerRenames,
} from 'src/speakers/speakerNameModel';

describe('serializeSpeakerNames', () => {
	it('trims and deduplicates the roster, first occurrence winning', () => {
		const result = serializeSpeakerNames({
			speakers: [' Speaker 1 ', 'Speaker 2', 'Speaker 1', '  '],
			names: {},
		});
		expect(result.speakers).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('drops empty and identity name mappings', () => {
		const result = serializeSpeakerNames({
			speakers: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
			names: {
				'Speaker 1': '  Alex ',
				'Speaker 2': '   ',
				'Speaker 3': 'Speaker 3',
			},
		});
		expect(result.names).toEqual({ 'Speaker 1': 'Alex' });
	});
});

describe('parseSpeakerNames', () => {
	it('parses a valid sidecar payload', () => {
		const result = parseSpeakerNames({
			version: 1,
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		});
		expect(result).toEqual({
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		});
	});

	it('maps a non-object payload to the empty state', () => {
		expect(parseSpeakerNames('nope')).toEqual(emptySpeakerNames());
		expect(parseSpeakerNames(null)).toEqual(emptySpeakerNames());
		expect(parseSpeakerNames(42)).toEqual(emptySpeakerNames());
	});

	it('discards non-string roster entries and name values', () => {
		const result = parseSpeakerNames({
			speakers: ['Speaker 1', 7, null],
			names: { 'Speaker 1': 'Alex', 'Speaker 2': 3 },
		});
		expect(result).toEqual({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
	});
});

describe('hasSpeakerData', () => {
	it('is false for the empty state and true with a roster or names', () => {
		expect(hasSpeakerData(emptySpeakerNames())).toBe(false);
		expect(hasSpeakerData({ speakers: ['Speaker 1'], names: {} })).toBe(
			true,
		);
		expect(
			hasSpeakerData({ speakers: [], names: { 'Speaker 1': 'Alex' } }),
		).toBe(true);
	});
});

describe('displaySpeaker', () => {
	it('returns the mapped name, falling back to the label', () => {
		const value = {
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		};
		expect(displaySpeaker(value, 'Speaker 1')).toBe('Alex');
		expect(displaySpeaker(value, 'Speaker 2')).toBe('Speaker 2');
	});
});

describe('speakerRenames', () => {
	const roster = ['Speaker 1', 'Speaker 2'];

	it('diffs newly named speakers from the original label', () => {
		expect(
			speakerRenames(
				{ speakers: roster, names: {} },
				{ speakers: roster, names: { 'Speaker 1': 'Alex' } },
			),
		).toEqual([{ from: 'Speaker 1', to: 'Alex' }]);
	});

	it('diffs a renamed speaker from its previous display name', () => {
		expect(
			speakerRenames(
				{ speakers: roster, names: { 'Speaker 1': 'Alex' } },
				{ speakers: roster, names: { 'Speaker 1': 'Sasha' } },
			),
		).toEqual([{ from: 'Alex', to: 'Sasha' }]);
	});

	it('diffs a cleared name back to the original label', () => {
		expect(
			speakerRenames(
				{ speakers: roster, names: { 'Speaker 2': 'Kim' } },
				{ speakers: roster, names: {} },
			),
		).toEqual([{ from: 'Kim', to: 'Speaker 2' }]);
	});

	it('returns nothing when the display names are unchanged', () => {
		expect(
			speakerRenames(
				{ speakers: roster, names: { 'Speaker 1': 'Alex' } },
				{ speakers: roster, names: { 'Speaker 1': 'Alex' } },
			),
		).toEqual([]);
	});
});

describe('participant registry helpers', () => {
	it('parses one name per line, trimmed and deduplicated', () => {
		expect(parseParticipants(' Alex \nKim\n\nalex\nAlex')).toEqual([
			'Alex',
			'Kim',
			'alex',
		]);
	});

	it('adds only new names and keeps the text unchanged otherwise', () => {
		expect(addParticipants('Alex\nKim', ['Kim', 'Dana'])).toBe(
			'Alex\nKim\nDana',
		);
		const unchanged = 'Alex\nKim';
		expect(addParticipants(unchanged, ['Alex', ' '])).toBe(unchanged);
	});

	it('builds a registry from scratch', () => {
		expect(addParticipants('', ['Alex', 'Kim'])).toBe('Alex\nKim');
	});
});
