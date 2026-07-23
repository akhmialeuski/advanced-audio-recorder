/**
 * Tests for the recording sidecar data model: parsing and normalizing v1/v2
 * documents, dropping broken parts without losing the rest, emptiness
 * predicates, and version-2 serialization.
 */

import {
	emptyTranscriptSection,
	isSidecarEmpty,
	isTranscriptSectionEmpty,
	parseRecordingSidecar,
	parseTranscriptSection,
	serializeRecordingSidecar,
	SIDECAR_HISTORY_LIMIT,
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
		llmProcessed: false,
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

	it('maps a non-object value to a fully empty document', () => {
		for (const value of [null, undefined, 'text', 42, []]) {
			const sidecar = parseRecordingSidecar(value);
			expect(sidecar.markers).toEqual([]);
			expect(isSidecarEmpty(sidecar)).toBe(true);
		}
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
					{ label: 'Speaker 1', name: 'Alex' },
					{ label: 'Speaker 2' },
				],
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
		expect(section.noteOutputs[0]?.llmProcessed).toBe(false);
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

describe('provenance and emptiness', () => {
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
