/**
 * Tests that the transcription service applies stored speaker names to the
 * canonical transcript (so every output format inherits them) and remembers
 * the freshly detected roster in the speaker-name store, without ever
 * discarding names the user already assigned.
 */

import type { App, TFile } from 'obsidian';
import {
	TranscriptionService,
	type SpeakerNameSource,
} from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type {
	Transcript,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import type { SpeakerNames } from 'src/speakers/speakerNameModel';
import { emptySpeakerNames } from 'src/speakers/speakerNameModel';

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'audio/rec.webm',
} as unknown as TFile;

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

/** In-memory speaker-name source recording reads and writes. */
function makeStore(initial: SpeakerNames): SpeakerNameSource & {
	saved: SpeakerNames | null;
} {
	const store = {
		saved: null as SpeakerNames | null,
		get: jest.fn(async () => initial),
		set: jest.fn(async (_path: string, value: SpeakerNames) => {
			store.saved = value;
		}),
	};
	return store;
}

function makeApp(): App {
	return {
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
	} as unknown as App;
}

const diarizedSegments: TranscriptSegment[] = [
	{ start: 0, end: 1, text: 'hi', speaker: 'Speaker 1' },
	{ start: 1, end: 2, text: 'hello', speaker: 'Speaker 2' },
];

async function runWith(
	store: SpeakerNameSource,
	segments: TranscriptSegment[] = diarizedSegments,
	diarize = true,
): Promise<{ markdown: string; transcript: Transcript }> {
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				transcriptionDiarize: diarize,
			}),
		{
			createProvider: () => makeProvider(segments),
			speakerNames: store,
		},
	);
	return service.run(audioFile, { notePathForLinks: 'note.md' });
}

describe('TranscriptionService speaker naming', () => {
	it('applies stored names to the transcript and the Markdown', async () => {
		const store = makeStore({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
		const { markdown, transcript } = await runWith(store);

		expect(transcript.speakers).toEqual(['Alex', 'Speaker 2']);
		expect(transcript.segments.map((s) => s.speaker)).toEqual([
			'Alex',
			'Speaker 2',
		]);
		expect(markdown).toContain('**Alex**');
		expect(markdown).not.toContain('Speaker 1');
	});

	it('remembers the detected roster while keeping existing names', async () => {
		const store = makeStore({
			speakers: ['Speaker 1'],
			names: { 'Speaker 1': 'Alex' },
		});
		await runWith(store);

		expect(store.set).toHaveBeenCalledWith(audioFile.path, {
			speakers: ['Speaker 1', 'Speaker 2'],
			names: { 'Speaker 1': 'Alex' },
		});
	});

	it('leaves labels untouched when nothing is stored', async () => {
		const store = makeStore(emptySpeakerNames());
		const { transcript } = await runWith(store);

		expect(transcript.speakers).toEqual(['Speaker 1', 'Speaker 2']);
		expect(store.saved).toEqual({
			speakers: ['Speaker 1', 'Speaker 2'],
			names: {},
		});
	});

	it('does not touch the store when diarization is off', async () => {
		const store = makeStore(emptySpeakerNames());
		const { transcript } = await runWith(store, diarizedSegments, false);

		expect(transcript.speakers).toEqual([]);
		expect(store.get).not.toHaveBeenCalled();
		expect(store.set).not.toHaveBeenCalled();
	});

	it('does not touch the store when the transcript has no speakers', async () => {
		const store = makeStore(emptySpeakerNames());
		await runWith(store, [{ start: 0, end: 1, text: 'hi' }]);

		expect(store.get).not.toHaveBeenCalled();
		expect(store.set).not.toHaveBeenCalled();
	});
});
