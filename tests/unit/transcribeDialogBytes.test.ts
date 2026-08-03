/**
 * The transcribe dialog reads the recording once and hands the same bytes to
 * the run it starts. That sharing is what this covers, through the real
 * metadata reader rather than a stand-in for it.
 *
 * The two halves were tested apart: the dialog against a mocked reader, the
 * reader against a mocked AudioContext. Nothing ran the pair, so when the
 * dialog moved onto a reader that can reach `decodeAudioData` - which does not
 * read its input but takes it, handing back a detached buffer - the run began
 * uploading an empty file and the engine answered that the audio was corrupt.
 * Neither suite could see it: one never called the reader, the other never
 * shared its bytes with anything.
 * @module tests/unit/transcribeDialogBytes.test
 */

import { App, Notice, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import { createFile } from '../helpers/createApp';
import {
	installAudioElementMock,
	installObjectUrlMock,
	type AudioElementDouble,
	type InstalledMock,
	type ObjectUrlDouble,
} from '../helpers/mediaMocks';

// Only the run itself is stood in for; the metadata reader under test is the
// real one, which is the whole point of this suite.
jest.mock('src/transcription/api', () => {
	const actual = jest.requireActual('src/transcription/api');
	return { __esModule: true, ...actual, transcribeFile: jest.fn() };
});

// The container will not parse, which is the one case that reaches the decode.
jest.mock('mediabunny', () => ({
	ALL_FORMATS: [],
	BufferSource: jest.fn(),
	UrlSource: jest.fn(),
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): Promise<never> =>
			Promise.reject(new Error('unparseable container')),
		computeDuration: (): Promise<number> => Promise.resolve(0),
		dispose: jest.fn(),
	})),
}));

import { transcribeFile } from 'src/transcription/api';

const transcribeMock = transcribeFile as jest.Mock;

/** The file's bytes, distinctive enough that an empty buffer cannot pass. */
const FILE_BYTES = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];

/** Buffers handed to decodeAudioData, which in Obsidian would be taken. */
let decoded: ArrayBuffer[] = [];
const mockDecodeAudioData = jest.fn((data: ArrayBuffer) => {
	decoded.push(data);
	return Promise.resolve({
		duration: 600,
		sampleRate: 48000,
		numberOfChannels: 2,
	});
});

class MockAudioContext {
	state = 'running';
	decodeAudioData = mockDecodeAudioData;
	close = (): Promise<void> => Promise.resolve();
}

/** Internals the dialog exposes to no one, driven here to start a run. */
interface ModalInternals {
	startRun: () => Promise<void>;
	probeFinished: boolean;
}

let audioMock: InstalledMock<AudioElementDouble>;
let urlMock: InstalledMock<ObjectUrlDouble>;
let warn: jest.SpyInstance;

/**
 * Lets the dialog's fire-and-forget probe finish before a run is started. It
 * reads the file and then walks every reader, so a single tick is not enough.
 * @param internals - The dialog whose probe is being waited on
 */
async function settle(internals: ModalInternals): Promise<void> {
	for (let tick = 0; tick < 50 && !internals.probeFinished; tick++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	if (!internals.probeFinished) {
		throw new Error('The duration probe never finished');
	}
}

beforeEach(() => {
	decoded = [];
	mockDecodeAudioData.mockClear();
	transcribeMock.mockReset();
	transcribeMock.mockResolvedValue({
		transcript: { segments: [], speakers: [] },
		markdown: '',
		cost: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			usd: null,
			usage: {},
		},
	});
	(Notice as unknown as jest.Mock).mockClear();
	urlMock = installObjectUrlMock();
	// The browser cannot read a length either, so the read goes all the way to
	// the decode - the only reader that takes what it is given.
	audioMock = installAudioElementMock((audio) => {
		audio.emit('error');
	});
	warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	Object.defineProperty(window, 'AudioContext', {
		writable: true,
		value: MockAudioContext,
	});
});

afterEach(() => {
	audioMock.restore();
	urlMock.restore();
	warn.mockRestore();
});

/** The dialog over one recording, with the vault read it drives. */
function createModal(): {
	modal: TranscriptionModal;
	internals: ModalInternals;
	bytes: ArrayBuffer;
} {
	const settings = {
		...DEFAULT_SETTINGS,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		deepgramApiKey: 'dg-live',
		llmPostProcessEnabled: false,
	};
	const bytes = new Uint8Array(FILE_BYTES).buffer;
	const app = new App();
	(app as unknown as { vault: Record<string, unknown> }).vault = {
		readBinary: jest.fn(() => Promise.resolve(bytes)),
		getResourcePath: (file: TFile): string => `app://vault/${file.path}`,
	};
	const file = createFile('Audio/meeting.webm');
	Object.defineProperty(file, 'name', { value: 'meeting.webm' });
	const modal = new TranscriptionModal(app, file, () => settings, {});
	return { modal, internals: modal as unknown as ModalInternals, bytes };
}

describe('the bytes the transcribe dialog shares with its run', () => {
	it('hands the run the file, not what the metadata read left behind', async () => {
		const { modal, internals, bytes } = createModal();
		modal.onOpen();
		await settle(internals);

		await internals.startRun();

		const passed = transcribeMock.mock.calls[0]?.[3] as {
			audioBytes?: ArrayBuffer;
		};
		// The very buffer the dialog read, still holding the file. A detached
		// one is the same object reading as zero bytes, which is exactly what
		// the engine rejected as corrupt audio.
		expect(passed.audioBytes).toBe(bytes);
		expect(
			Array.from(new Uint8Array(passed.audioBytes ?? new ArrayBuffer(0))),
		).toEqual(FILE_BYTES);
	});

	it('never gives the decoder the buffer the run will use', async () => {
		// The decode is where a buffer stops being the caller's, and no mock of
		// it can reproduce that in jsdom - an ArrayBuffer cannot be detached
		// here. So the rule is asserted directly instead: whatever the decoder
		// is handed, it is not the object the run is handed.
		const { modal, internals } = createModal();
		modal.onOpen();
		await settle(internals);

		await internals.startRun();

		const passed = transcribeMock.mock.calls[0]?.[3] as {
			audioBytes?: ArrayBuffer;
		};
		expect(decoded).toHaveLength(1);
		expect(decoded[0]).not.toBe(passed.audioBytes);
		// And it was a copy of the file rather than something else entirely,
		// so the metadata it produced describes the recording being run.
		expect(
			Array.from(new Uint8Array(decoded[0] ?? new ArrayBuffer(0))),
		).toEqual(FILE_BYTES);
	});
});
