/**
 * @jest-environment jsdom
 */

/**
 * Tests that a multi-part transcription keeps the parts that succeeded when a
 * later part fails (e.g. a Gemini MAX_TOKENS truncation), instead of discarding
 * a completed — and, on a paid API, already-billed — transcript. The note flags
 * the gap, the user is warned, and only when every part fails does the run
 * surface an error.
 * @module tests/unit/transcriptionServicePartFailure.test
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import { prepareAudio } from 'src/transcription/audioPrep';
import { mergeSettings } from 'src/settings/Settings';

jest.mock('obsidian', () => {
	const actual = jest.requireActual('../mocks/obsidian');
	return { ...actual, Notice: jest.fn() };
});

// Replace audio preparation so the test drives the part count directly without
// decoding real audio (the Web Audio path is unavailable under jsdom).
jest.mock('src/transcription/audioPrep', () => ({
	prepareAudio: jest.fn(),
	audioMimeFromExtension: jest.fn(() => 'audio/webm'),
	audioPrepOptions: jest.fn(() => ({})),
}));

const mockPrepareAudio = prepareAudio as jest.Mock;
const mockNotice = Notice as unknown as jest.Mock;

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(): App {
	return {
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
			create: jest.fn(),
			adapter: { exists: jest.fn(async () => false) },
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
		workspace: { getLeavesOfType: jest.fn(() => []) },
	} as unknown as App;
}

/** Two prepared parts on the timeline (0s and 60s), each a tiny WAV payload. */
function prepareTwoParts(): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio-0.wav',
				offsetSeconds: 0,
				createData: () => new ArrayBuffer(4),
			},
			{
				contentType: 'audio/wav',
				filename: 'audio-1.wav',
				offsetSeconds: 60,
				createData: () => new ArrayBuffer(4),
			},
		],
		diarizationSplitWarning: false,
	});
}

function makeProvider(transcribe: jest.Mock): TranscriptionProvider {
	return {
		id: 'fake',
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: false,
		},
		transcribe,
	};
}

const baseSettings = {
	transcriptionProvider: 'gemini' as const,
	geminiApiKey: 'gm-test',
};

describe('TranscriptionService multi-part salvage', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		prepareTwoParts();
	});

	it('keeps the successful part when a later part hits the token limit', async () => {
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'part one' }],
			})
			.mockRejectedValueOnce(
				new Error(
					'Gemini stopped because it reached its output token limit',
				),
			);
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(transcribe).toHaveBeenCalledTimes(2);
		// The completed part survives rather than being discarded.
		expect(result.transcript.segments.map((s) => s.text)).toEqual([
			'part one',
		]);
		// The note flags the gap so a partial transcript is not read as whole.
		expect(result.markdown).toContain('Transcription incomplete');
		expect(result.markdown).toContain('part 2 of 2');
		expect(result.markdown).toContain('part one');
		// The user is warned, carrying the underlying provider message.
		expect(mockNotice).toHaveBeenCalledTimes(1);
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('output token limit'),
		);
	});

	it('throws only when every part fails, naming the first failure', async () => {
		const transcribe = jest
			.fn()
			.mockRejectedValueOnce(new Error('first failed'))
			.mockRejectedValueOnce(new Error('second failed'));
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		await expect(
			service.run(audioFile, {
				notePathForLinks: 'note.md',
				token: NEVER_CANCELLED,
			}),
		).rejects.toThrow(/first failed \(while transcribing part 1 of 2\)/);
		expect(mockNotice).not.toHaveBeenCalled();
	});
});
