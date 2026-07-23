/**
 * Tests for the transcription flow's sidecar integration: stored speaker
 * names are re-applied to a fresh diarized transcript (so a re-transcription
 * keeps "Alex" without user action), the stored roster is refreshed with
 * names preserved, a changed label composition warns the user, the written
 * outputs are registered (with the run's template snapshot, heading, and
 * provenance) for every run - diarized or not - and the name continuity is a
 * strict no-op without diarization, without speakers, or without a store.
 * The store reaches the run through a single channel: the run options.
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import {
	emptyTranscriptSection,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
import { transcribeFile } from 'src/transcription/runTranscription';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import {
	insertTranscriptIntoNote,
	notifyTranscriptWritten,
	writeTranscriptFile,
} from 'src/transcription/transcriptOutput';

jest.mock('src/transcription/transcriptOutput', () => ({
	writeTranscriptFile: jest.fn(),
	insertTranscriptIntoNote: jest.fn(),
	insertTranscriptFileLink: jest.fn(),
	notifyTranscriptWritten: jest.fn(),
}));

const writeFileMock = writeTranscriptFile as jest.Mock;
const insertMock = insertTranscriptIntoNote as jest.Mock;
const notifyMock = notifyTranscriptWritten as jest.Mock;

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'audio/rec.webm',
} as unknown as TFile;

/** A whole-file provider returning the given diarized segments. */
function makeProvider(segments: TranscriptSegment[]): TranscriptionProvider {
	return {
		id: 'fake',
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: true,
			supportsDictionary: true,
		},
		transcribe: jest.fn(async () => ({ segments })),
	};
}

/** Minimal App surface the service touches on the whole-file path. */
function makeApp(): App {
	return {
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(
				(_f: unknown, _n: unknown, _s: unknown, label: string) =>
					`[${label}](rec.webm#t=0)`,
			),
		},
	} as unknown as App;
}

/** A sidecar stub whose getTranscript resolves to the given section. */
function makeSidecar(section: TranscriptSection): {
	getTranscript: jest.Mock;
	setSpeakers: jest.Mock;
	recordNoteOutput: jest.Mock;
	recordFileOutput: jest.Mock;
	recordProvenance: jest.Mock;
} {
	return {
		getTranscript: jest.fn().mockResolvedValue(section),
		setSpeakers: jest.fn().mockResolvedValue(undefined),
		recordNoteOutput: jest.fn().mockResolvedValue(undefined),
		recordFileOutput: jest.fn().mockResolvedValue(undefined),
		recordProvenance: jest.fn().mockResolvedValue(undefined),
	};
}

function diarizedSettings(
	overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	return mergeSettings({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcriptionDiarize: true,
		...overrides,
	});
}

const twoSpeakerSegments: TranscriptSegment[] = [
	{ start: 0, end: 1, text: 'hello', speaker: 'Speaker 1' },
	{ start: 1, end: 2, text: 'hi', speaker: 'Speaker 2' },
];

describe('TranscriptionService stored speaker names', () => {
	it('re-applies stored names to every output and refreshes the roster', async () => {
		const sidecar = makeSidecar({
			...emptyTranscriptSection(),
			speakers: [{ label: 'Speaker 1', name: 'Alex' }],
		});
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		const { transcript, markdown } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar,
		});

		expect(transcript.speakers).toEqual(['Alex', 'Speaker 2']);
		expect(transcript.segments.map((segment) => segment.speaker)).toEqual([
			'Alex',
			'Speaker 2',
		]);
		expect(markdown).toContain('**Alex**');
		expect(markdown).not.toContain('Speaker 1');
		// Roster refreshed with the run's labels; the matched name survives
		// and the new label joins unnamed.
		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.webm', [
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		]);
	});

	it('warns when the label composition changed against the stored roster', async () => {
		const sidecar = makeSidecar({
			...emptyTranscriptSection(),
			speakers: [{ label: 'Speaker 1', name: 'Alex' }],
		});
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		await service.run(audioFile, { notePathForLinks: 'note.md', sidecar });
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Speaker labels changed'),
		);
	});

	it('does not warn when the composition is unchanged', async () => {
		const sidecar = makeSidecar({
			...emptyTranscriptSection(),
			speakers: [
				{ label: 'Speaker 2' },
				{ label: 'Speaker 1', name: 'Alex' },
			],
		});
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		await service.run(audioFile, { notePathForLinks: 'note.md', sidecar });
		expect(Notice).not.toHaveBeenCalledWith(
			expect.stringContaining('Speaker labels changed'),
		);
	});

	it('drops a stored name that collides with another label of the run', async () => {
		// Round 1 named the only speaker "Speaker 2"; round 2 detects a real
		// Speaker 2. Applying the stored name would render both speakers as
		// "Speaker 2" and merge them in every output beyond repair, so it is
		// neither applied nor kept in the refreshed roster.
		const sidecar = makeSidecar({
			...emptyTranscriptSection(),
			speakers: [{ label: 'Speaker 1', name: 'Speaker 2' }],
		});
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		const { transcript } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar,
		});

		expect(transcript.speakers).toEqual(['Speaker 1', 'Speaker 2']);
		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.webm', [
			{ label: 'Speaker 1' },
			{ label: 'Speaker 2' },
		]);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining("matched another speaker's label"),
		);
	});

	it('keeps hostile engine labels as plain data (no prototype lookups)', async () => {
		// A provider label colliding with an Object.prototype member must not
		// resolve to the inherited function and pollute the stored roster.
		const sidecar = makeSidecar(emptyTranscriptSection());
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{
				createProvider: () =>
					makeProvider([
						{
							start: 0,
							end: 1,
							text: 'hello',
							speaker: 'toString',
						},
						{
							start: 1,
							end: 2,
							text: 'hi',
							speaker: 'constructor',
						},
					]),
			},
		);
		const { transcript } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar,
		});

		expect(transcript.speakers).toEqual(['toString', 'constructor']);
		expect(transcript.segments.map((segment) => segment.speaker)).toEqual([
			'toString',
			'constructor',
		]);
		expect(sidecar.setSpeakers).toHaveBeenCalledWith('audio/rec.webm', [
			{ label: 'toString' },
			{ label: 'constructor' },
		]);
	});

	it('does not touch the sidecar without effective diarization', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings({ transcriptionDiarize: false }),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		const { transcript } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar,
		});
		expect(transcript.speakers).toEqual([]);
		expect(sidecar.getTranscript).not.toHaveBeenCalled();
		expect(sidecar.setSpeakers).not.toHaveBeenCalled();
	});

	it('does not touch the sidecar when the transcript has no speakers', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{
				createProvider: () =>
					makeProvider([{ start: 0, end: 1, text: 'hi' }]),
			},
		);
		await service.run(audioFile, { notePathForLinks: 'note.md', sidecar });
		expect(sidecar.getTranscript).not.toHaveBeenCalled();
		expect(sidecar.setSpeakers).not.toHaveBeenCalled();
	});

	it('runs unchanged without a sidecar in the run options', async () => {
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		const { transcript } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});
		expect(transcript.speakers).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('keeps the original labels when the sidecar read fails', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		sidecar.getTranscript.mockRejectedValue(new Error('io error'));
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const service = new TranscriptionService(
			makeApp(),
			() => diarizedSettings(),
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		const { transcript } = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			sidecar,
		});
		expect(transcript.speakers).toEqual(['Speaker 1', 'Speaker 2']);
		warn.mockRestore();
	});
});

describe('transcribeFile output registration', () => {
	beforeEach(() => {
		writeFileMock.mockReset();
		insertMock.mockReset();
		notifyMock.mockReset();
	});

	it('records the written file and note outputs with the run template snapshot', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		writeFileMock.mockResolvedValue({
			path: 'audio/rec_1.transcript.json',
		});
		insertMock.mockReturnValue(true);
		// A per-run override that must land in the recorded templates even
		// though it differs from the shipped default.
		const settings = diarizedSettings({
			transcriptDestination: 'both',
			transcriptIncludeTimestamps: false,
		});
		await transcribeFile(
			makeApp(),
			() => settings,
			audioFile,
			{ notePathForLinks: 'Meetings/note.md', sidecar },
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);

		expect(sidecar.recordFileOutput).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({
				path: 'audio/rec_1.transcript.json',
				format: settings.transcriptFileFormat,
				writtenAt: expect.any(String),
			}),
		);
		expect(sidecar.recordNoteOutput).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({
				path: 'Meetings/note.md',
				templates: {
					lineFormat: settings.transcriptLineFormat,
					speakerFormat: settings.transcriptSpeakerFormat,
					includeTimestamps: false,
					timestampLinks: settings.transcriptTimestampLinks,
					mergeConsecutiveSpeaker:
						settings.transcriptMergeConsecutiveSpeaker,
				},
				llmProcessed: false,
				heading: settings.transcriptHeading,
			}),
		);
		// The run's provenance is recorded alongside the outputs, so the
		// sidecar can answer when (and by what) the transcript was produced.
		expect(sidecar.recordProvenance).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({ createdAt: expect.any(String) }),
		);
	});

	it('marks the note output llmProcessed for a cleanup pass', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		insertMock.mockReturnValue(true);
		const settings = diarizedSettings({
			transcriptDestination: 'note',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
		});
		await transcribeFile(
			makeApp(),
			() => settings,
			audioFile,
			{ notePathForLinks: 'note.md', sidecar },
			{
				createProvider: () => makeProvider(twoSpeakerSegments),
				createLlm: () => ({
					complete: jest.fn(async () => 'cleaned body'),
				}),
			},
		);
		expect(sidecar.recordNoteOutput).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({ llmProcessed: true }),
		);
	});

	it('does not mark the note output llmProcessed for a summary pass', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		insertMock.mockReturnValue(true);
		const settings = diarizedSettings({
			transcriptDestination: 'note',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'summary',
		});
		await transcribeFile(
			makeApp(),
			() => settings,
			audioFile,
			{ notePathForLinks: 'note.md', sidecar },
			{
				createProvider: () => makeProvider(twoSpeakerSegments),
				createLlm: () => ({
					complete: jest.fn(async () => 'a summary'),
				}),
			},
		);
		expect(sidecar.recordNoteOutput).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({ llmProcessed: false }),
		);
	});

	it('registers the outputs of a non-diarized run too', async () => {
		// The sidecar is the general transcript ledger: an absent record must
		// mean "no transcript", never "a transcript this feature ignored".
		const sidecar = makeSidecar(emptyTranscriptSection());
		insertMock.mockReturnValue(true);
		const settings = diarizedSettings({
			transcriptDestination: 'note',
			transcriptionDiarize: false,
		});
		await transcribeFile(
			makeApp(),
			() => settings,
			audioFile,
			{ notePathForLinks: 'note.md', sidecar },
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		expect(sidecar.recordNoteOutput).toHaveBeenCalledWith(
			'audio/rec.webm',
			expect.objectContaining({ path: 'note.md' }),
		);
		expect(sidecar.recordProvenance).toHaveBeenCalled();
		expect(sidecar.recordFileOutput).not.toHaveBeenCalled();
	});

	it('registers nothing when no output was written', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		insertMock.mockReturnValue(false);
		const settings = diarizedSettings({ transcriptDestination: 'note' });
		writeFileMock.mockResolvedValue(null);
		await transcribeFile(
			makeApp(),
			() => settings,
			audioFile,
			{ notePathForLinks: 'note.md', sidecar },
			{ createProvider: () => makeProvider(twoSpeakerSegments) },
		);
		expect(sidecar.recordNoteOutput).not.toHaveBeenCalled();
		expect(sidecar.recordFileOutput).not.toHaveBeenCalled();
		expect(sidecar.recordProvenance).not.toHaveBeenCalled();
	});

	it('does not fail the run when output registration throws', async () => {
		const sidecar = makeSidecar(emptyTranscriptSection());
		sidecar.recordNoteOutput.mockRejectedValue(new Error('disk full'));
		insertMock.mockReturnValue(true);
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const settings = diarizedSettings({ transcriptDestination: 'note' });
		await expect(
			transcribeFile(
				makeApp(),
				() => settings,
				audioFile,
				{ notePathForLinks: 'note.md', sidecar },
				{ createProvider: () => makeProvider(twoSpeakerSegments) },
			),
		).resolves.toBeDefined();
		warn.mockRestore();
	});
});
