/**
 * Tests for the recording sidecar data model: parsing and normalizing v1/v2
 * documents, dropping broken parts without losing the rest, emptiness
 * predicates, and version-2 serialization.
 */

import {
	cloneSpeakerEntry,
	cloneTranscriptSection,
	emptyTranscriptSection,
	isSidecarEmpty,
	isTranscriptSectionEmpty,
	parseRecordingSidecar,
	parseTranscriptSection,
	serializeRecordingSidecar,
	SIDECAR_HISTORY_LIMIT,
	withSpeakerName,
	type NoteOutput,
} from 'src/sidecar/recordingSidecarModel';
import type { PlayerMarker } from 'src/markers/markerModel';

const marker: PlayerMarker = {
	id: 'a',
	time: 1,
	label: 'a',
	kind: 'bookmark',
};

function noteOutput(path: string): NoteOutput {
	return {
		path,
		templates: {
			lineFormat: '{timestamp} {speaker} {text}',
			speakerFormat: '**{speaker}**',
			includeTimestamps: true,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		},
		heading: 'Transcript',
		writtenAt: '2026-07-21T10:00:00Z',
	};
}

describe('parseRecordingSidecar', () => {
	it('reads a version-1 markers file with an empty transcript section', () => {
		const sidecar = parseRecordingSidecar({
			version: 1,
			markers: [marker],
		});
		expect(sidecar.markers).toEqual([marker]);
		expect(isTranscriptSectionEmpty(sidecar.transcript)).toBe(true);
	});

	it.each([
		{ name: 'a missing file', value: null },
		{ name: 'a file that read as nothing', value: undefined },
		{ name: 'plain text', value: 'text' },
		{ name: 'a number', value: 42 },
		{ name: 'a bare list', value: [] },
		// The shapes that are objects but say nothing, and the one that says
		// the wrong thing: an empty object, and sections of the wrong type.
		{ name: 'an object with nothing in it', value: {} },
		{ name: 'a boolean', value: false },
		{
			name: 'markers stored as something other than a list',
			value: { markers: 'none' },
		},
		{ name: 'a transcript stored as a list', value: { transcript: [] } },
	])('maps $name to a fully empty document', ({ value }) => {
		// The sidecar is a file on disk that anything may have written; a
		// shape it does not recognise has to read as "nothing stored yet"
		// rather than throw on the next marker write.
		const sidecar = parseRecordingSidecar(value);

		expect(sidecar.markers).toEqual([]);
		expect(isSidecarEmpty(sidecar)).toBe(true);
	});

	it('keeps markers when the transcript section is broken, and vice versa', () => {
		const brokenTranscript = parseRecordingSidecar({
			version: 2,
			markers: [marker],
			transcript: 'garbage',
		});
		expect(brokenTranscript.markers).toEqual([marker]);
		expect(isTranscriptSectionEmpty(brokenTranscript.transcript)).toBe(
			true,
		);

		const brokenMarkers = parseRecordingSidecar({
			version: 2,
			markers: 'garbage',
			transcript: { speakers: [{ label: 'Speaker 1' }] },
		});
		expect(brokenMarkers.markers).toEqual([]);
		expect(brokenMarkers.transcript.speakers).toEqual([
			{ label: 'Speaker 1' },
		]);
	});

	it('round-trips a full version-2 document through serialization', () => {
		const original = {
			markers: [marker],
			transcript: {
				speakers: [
					{
						label: 'Speaker 1',
						name: 'Alex',
						firstStart: 12.5,
						firstEnd: 20,
					},
					{ label: 'Speaker 2' },
				],
				participants: ['Alex', 'Bob'],
				participantProfileId: 'profile-1',
				noteOutputs: [noteOutput('Meetings/note.md')],
				fileOutputs: [
					{
						path: 'audio/rec.transcript.json',
						format: 'json' as const,
						writtenAt: '2026-07-21T10:00:00Z',
					},
				],
				history: [
					{
						at: '2026-07-21T10:05:00Z',
						names: { 'Speaker 1': 'Alex' },
					},
				],
				provenance: {
					language: 'en',
					model: 'nova-2',
					createdAt: '2026-07-21T10:00:00Z',
				},
			},
		};
		const parsed = parseRecordingSidecar(
			serializeRecordingSidecar(original),
		);
		expect(parsed).toEqual(original);
	});
});

describe('parseTranscriptSection normalization', () => {
	it('normalizes speaker entries: trims, drops broken ones, first label wins', () => {
		const section = parseTranscriptSection({
			speakers: [
				{ label: '  Speaker 1  ', name: '  Alex  ' },
				{ label: 'Speaker 1', name: 'Bob' },
				{ label: '   ' },
				{ label: 42, name: 'X' },
				'not an object',
				{ label: 'Speaker 2', name: 'Speaker 2' },
				{ label: 'Speaker 3', name: '' },
			],
		});
		expect(section.speakers).toEqual([
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
			{ label: 'Speaker 3' },
		]);
	});

	it('drops note outputs without a usable path or templates', () => {
		const good = noteOutput('note.md');
		const section = parseTranscriptSection({
			noteOutputs: [
				good,
				{ path: '', templates: good.templates },
				{ path: 'no-templates.md' },
				{ path: 'bad-templates.md', templates: { lineFormat: 7 } },
				{ ...good, path: 'note.md' },
			],
		});
		expect(section.noteOutputs).toEqual([good]);
	});

	it('defaults missing template flags without dropping the entry', () => {
		const section = parseTranscriptSection({
			noteOutputs: [
				{
					path: 'note.md',
					templates: {
						lineFormat: '{speaker} {text}',
						speakerFormat: '{speaker}:',
						includeTimestamps: false,
					},
				},
			],
		});
		expect(section.noteOutputs[0]?.templates).toEqual({
			lineFormat: '{speaker} {text}',
			speakerFormat: '{speaker}:',
			includeTimestamps: false,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		});
		expect(section.noteOutputs[0]?.writtenAt).toBe('');
	});

	it('drops file outputs with an unknown format and keeps the first per path', () => {
		const section = parseTranscriptSection({
			fileOutputs: [
				{ path: 'rec.srt', format: 'srt', writtenAt: 't1' },
				{ path: 'rec.srt', format: 'vtt', writtenAt: 't2' },
				{ path: 'rec.docx', format: 'docx', writtenAt: 't3' },
				{ path: 'rec.txt', format: 'txt' },
			],
		});
		expect(section.fileOutputs).toEqual([
			{ path: 'rec.srt', format: 'srt', writtenAt: 't1' },
			{ path: 'rec.txt', format: 'txt', writtenAt: '' },
		]);
	});

	it('keeps only usable provenance fields and omits an empty provenance', () => {
		expect(
			parseTranscriptSection({
				provenance: { language: ' en ', model: 42, createdAt: '' },
			}).provenance,
		).toEqual({ language: 'en' });
		expect(
			parseTranscriptSection({ provenance: {} }).provenance,
		).toBeUndefined();
		expect(
			parseTranscriptSection({ provenance: 'garbage' }).provenance,
		).toBeUndefined();
	});

	it('keeps hostile history labels as plain data instead of prototype keys', () => {
		const section = parseTranscriptSection({
			history: [
				{
					at: 't',
					names: {
						['__proto__']: 'Evil',
						constructor: 'Sneaky',
						'Speaker 1': 'Alex',
					},
				},
			],
		});
		const names = section.history[0]?.names ?? {};
		// The hostile labels are ordinary own keys on a null-prototype map...
		expect(Object.hasOwn(names, '__proto__')).toBe(true);
		expect(Object.hasOwn(names, 'constructor')).toBe(true);
		expect(names['Speaker 1']).toBe('Alex');
		// ...and nothing leaked onto Object.prototype.
		expect(({} as Record<string, unknown>).Evil).toBeUndefined();
		expect(Object.getPrototypeOf(names)).toBeNull();
	});

	it('keeps only string name values in history and caps the entries', () => {
		const entries = Array.from({ length: 15 }, (_v, i) => ({
			at: `t${String(i)}`,
			names: { 'Speaker 1': `Name ${String(i)}`, 'Speaker 2': 42 },
		}));
		const section = parseTranscriptSection({ history: entries });
		expect(section.history).toHaveLength(SIDECAR_HISTORY_LIMIT);
		expect(section.history[0]?.at).toBe('t5');
		expect(section.history[9]?.names).toEqual({ 'Speaker 1': 'Name 14' });
	});
});

describe('isSidecarEmpty', () => {
	it('is empty only when markers and every transcript list are empty', () => {
		expect(
			isSidecarEmpty({
				markers: [],
				transcript: emptyTranscriptSection(),
			}),
		).toBe(true);
		expect(
			isSidecarEmpty({
				markers: [marker],
				transcript: emptyTranscriptSection(),
			}),
		).toBe(false);
		for (const partial of [
			{ speakers: [{ label: 'Speaker 1' }] },
			{ noteOutputs: [noteOutput('note.md')] },
			{
				fileOutputs: [
					{ path: 'p', format: 'txt' as const, writtenAt: '' },
				],
			},
			{ history: [{ at: '', names: {} }] },
			// The user's own names outlive the roster they were entered
			// against, so they alone keep the sidecar worth persisting.
			{ participants: ['Alex'] },
		]) {
			expect(
				isSidecarEmpty({
					markers: [],
					transcript: { ...emptyTranscriptSection(), ...partial },
				}),
			).toBe(false);
		}
	});
});

describe('serializeRecordingSidecar', () => {
	it('omits the transcript key while the section is empty', () => {
		const payload = serializeRecordingSidecar({
			markers: [marker],
			transcript: emptyTranscriptSection(),
		});
		expect(payload.version).toBe(2);
		expect(payload.markers).toEqual([marker]);
		expect('transcript' in payload).toBe(false);
	});
});

describe('speaker first-turn offsets', () => {
	it('keeps a forward span and drops what cannot locate a speaker', () => {
		const section = parseTranscriptSection({
			speakers: [
				{ label: 'Speaker 1', firstStart: 12.5, firstEnd: 20 },
				// An end without a start locates nothing; the start alone is
				// still enough to begin a preview.
				{ label: 'Speaker 2', firstEnd: 30 },
				{ label: 'Speaker 3', firstStart: 5 },
				// Not a span: the end precedes the start.
				{ label: 'Speaker 4', firstStart: 30, firstEnd: 10 },
			],
		});
		expect(section.speakers).toEqual([
			{ label: 'Speaker 1', firstStart: 12.5, firstEnd: 20 },
			{ label: 'Speaker 2' },
			{ label: 'Speaker 3', firstStart: 5 },
			{ label: 'Speaker 4', firstStart: 30 },
		]);
	});

	it('drops offsets that are not usable numbers, keeping the entry', () => {
		const section = parseTranscriptSection({
			speakers: [
				{ label: 'Speaker 1', firstStart: '12', firstEnd: 20 },
				{ label: 'Speaker 2', firstStart: -1 },
				{ label: 'Speaker 3', firstStart: Number.NaN },
				{ label: 'Speaker 4', firstStart: Number.POSITIVE_INFINITY },
				{ label: 'Speaker 5', firstStart: 0, firstEnd: 0 },
			],
		});
		expect(section.speakers).toEqual([
			{ label: 'Speaker 1' },
			{ label: 'Speaker 2' },
			{ label: 'Speaker 3' },
			{ label: 'Speaker 4' },
			// Zero is a real offset, and a zero-length turn is a real span.
			{ label: 'Speaker 5', firstStart: 0, firstEnd: 0 },
		]);
	});

	it('survives a name change without losing the offsets', () => {
		const entry = {
			label: 'Speaker 1',
			name: 'Alex',
			firstStart: 3,
			firstEnd: 9,
		};
		expect(withSpeakerName(entry, 'Bob')).toEqual({
			label: 'Speaker 1',
			name: 'Bob',
			firstStart: 3,
			firstEnd: 9,
		});
		// Clearing the name reverts the speaker to its label; the preview it
		// was identified with must not be the price of that.
		expect(withSpeakerName(entry, '')).toEqual({
			label: 'Speaker 1',
			firstStart: 3,
			firstEnd: 9,
		});
	});

	it('clones an entry independently of the original', () => {
		const entry = { label: 'Speaker 1', firstStart: 3 };
		const copy = cloneSpeakerEntry(entry);
		copy.firstStart = 99;
		expect(entry.firstStart).toBe(3);
		expect(cloneSpeakerEntry({ label: 'Speaker 2' })).toEqual({
			label: 'Speaker 2',
		});
	});
});

describe('participant roster', () => {
	it('normalizes the stored names and keeps a usable profile id', () => {
		const section = parseTranscriptSection({
			participants: ['  Alex ', 'Bob', 'Alex', '', 42, 'Cleo'],
			participantProfileId: '  profile-1  ',
		});
		expect(section.participants).toEqual(['Alex', 'Bob', 'Cleo']);
		expect(section.participantProfileId).toBe('profile-1');
	});

	it('degrades a non-list roster and a blank profile id to nothing', () => {
		const section = parseTranscriptSection({
			participants: 'Alex',
			participantProfileId: '   ',
		});
		expect(section.participants).toEqual([]);
		expect(section.participantProfileId).toBeUndefined();
	});

	it('defaults to an empty roster for a section that has none', () => {
		expect(parseTranscriptSection({}).participants).toEqual([]);
		expect(emptyTranscriptSection().participants).toEqual([]);
	});

	it('clones the roster rather than aliasing it', () => {
		const section = {
			...emptyTranscriptSection(),
			participants: ['Alex'],
			participantProfileId: 'profile-1',
		};
		const copy = cloneTranscriptSection(section);
		copy.participants.push('Bob');
		expect(section.participants).toEqual(['Alex']);
		expect(copy.participantProfileId).toBe('profile-1');
	});
});

describe('provenance and emptiness', () => {
	it('treats a profile-id-only section as empty (deletable sidecar)', () => {
		// The id only names where the participants came from; with no
		// participants left it describes nothing.
		const section = {
			...emptyTranscriptSection(),
			participantProfileId: 'profile-1',
		};
		expect(isTranscriptSectionEmpty(section)).toBe(true);
	});

	it('treats a provenance-only section as empty (deletable sidecar)', () => {
		// Provenance describes the run behind the section's lists; once
		// those are empty there is nothing left to describe, and counting
		// it would keep an emptied sidecar file on disk forever.
		const section = {
			...emptyTranscriptSection(),
			provenance: { language: 'en', createdAt: 't' },
		};
		expect(isTranscriptSectionEmpty(section)).toBe(true);
		expect(isSidecarEmpty({ markers: [], transcript: section })).toBe(true);
		// With markers present the document is still worth persisting.
		expect(isSidecarEmpty({ markers: [marker], transcript: section })).toBe(
			false,
		);
	});
});

describe('the remembered playback position', () => {
	const AT = '2026-08-28T10:00:00.000Z';

	it('parses a position written alongside the other sections', () => {
		const parsed = parseRecordingSidecar({
			version: 2,
			markers: [marker],
			playback: { position: 842, updatedAt: AT },
		});

		expect(parsed.playback).toEqual({ position: 842, updatedAt: AT });
		expect(parsed.markers).toEqual([marker]);
	});

	it.each([
		{ case: 'no section at all', value: undefined },
		{ case: 'a section that is not an object', value: 'somewhere' },
		{ case: 'a position of zero', value: { position: 0, updatedAt: AT } },
		{
			case: 'a negative position',
			value: { position: -30, updatedAt: AT },
		},
		{
			case: 'a position that is not a number',
			value: { position: '842', updatedAt: AT },
		},
		{
			case: 'an infinite position',
			value: { position: Infinity, updatedAt: AT },
		},
		{ case: 'no write timestamp', value: { position: 842 } },
	])('remembers nothing from $case', ({ value }) => {
		const parsed = parseRecordingSidecar({ version: 2, playback: value });

		expect(parsed.playback).toBeUndefined();
	});

	it('survives a transcript section that cannot be parsed', () => {
		const parsed = parseRecordingSidecar({
			version: 2,
			transcript: 'corrupt',
			playback: { position: 842, updatedAt: AT },
		});

		expect(parsed.playback?.position).toBe(842);
	});

	it('writes the section back, and omits it when there is none', () => {
		const withPosition = serializeRecordingSidecar({
			markers: [],
			transcript: emptyTranscriptSection(),
			playback: { position: 842, updatedAt: AT },
		});
		expect(withPosition.playback).toEqual({ position: 842, updatedAt: AT });

		const without = serializeRecordingSidecar({
			markers: [marker],
			transcript: emptyTranscriptSection(),
		});
		expect('playback' in without).toBe(false);
	});

	it('keeps a sidecar that holds only a position', () => {
		// The position has to count as content, or a recording with no
		// markers could never be resumed: the file would be deleted the
		// moment it was written.
		expect(
			isSidecarEmpty({
				markers: [],
				transcript: emptyTranscriptSection(),
				playback: { position: 842, updatedAt: AT },
			}),
		).toBe(false);
	});
});

describe('a transcript file written as a translation', () => {
	const AT = '2026-08-29T10:00:00.000Z';

	it('records the language it was translated into', () => {
		const parsed = parseRecordingSidecar({
			version: 2,
			transcript: {
				fileOutputs: [
					{
						path: 'rec.Spanish.srt',
						format: 'srt',
						writtenAt: AT,
						language: 'Spanish',
					},
				],
			},
		});

		expect(parsed.transcript.fileOutputs).toEqual([
			{
				path: 'rec.Spanish.srt',
				format: 'srt',
				writtenAt: AT,
				language: 'Spanish',
			},
		]);
	});

	it.each([
		{ case: 'the recording own language', value: undefined },
		{ case: 'a language that is not a string', value: 7 },
		{ case: 'a blank language', value: '  ' },
	])('records no language for $case', ({ value }) => {
		const parsed = parseRecordingSidecar({
			version: 2,
			transcript: {
				fileOutputs: [
					{
						path: 'rec.srt',
						format: 'srt',
						writtenAt: AT,
						...(value === undefined ? {} : { language: value }),
					},
				],
			},
		});

		expect(parsed.transcript.fileOutputs[0]?.language).toBeUndefined();
	});

	it('writes the language back, and omits it for the original', () => {
		const payload = serializeRecordingSidecar({
			markers: [],
			transcript: {
				...emptyTranscriptSection(),
				fileOutputs: [
					{ path: 'a.srt', format: 'srt', writtenAt: AT },
					{
						path: 'a.Spanish.srt',
						format: 'srt',
						writtenAt: AT,
						language: 'Spanish',
					},
				],
			},
		});

		expect(payload.transcript).toMatchObject({
			fileOutputs: [
				{ path: 'a.srt', format: 'srt', writtenAt: AT },
				{
					path: 'a.Spanish.srt',
					format: 'srt',
					writtenAt: AT,
					language: 'Spanish',
				},
			],
		});
		const outputs = (
			payload.transcript as { fileOutputs: Record<string, unknown>[] }
		).fileOutputs;
		expect('language' in (outputs[0] ?? {})).toBe(false);
	});
});
