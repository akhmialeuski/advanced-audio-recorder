/**
 * A split that streams, end to end: the split service, the streamed split,
 * the encoder configuration and the real mediabunny, with only the vault
 * faked.
 *
 * An A-law WAV is the source because it is the one compressed file jsdom can
 * decode: the WAV byte copy cannot take it, since A-law is not linear PCM,
 * and mediabunny decodes it itself, without WebCodecs. Nothing here can fall
 * back to the whole-file decode either - jsdom has no AudioContext - so a
 * split that finishes is one that streamed.
 * @module tests/unit/streamedSplit.test
 */

import { App, TFile } from 'obsidian';
import { SplitService } from 'src/recording/SplitService';
import { parseWavLayout } from 'src/recording/AudioSplitter';
import { createMockApp } from '../helpers/createApp';
import { defined } from '../helpers/assertions';
import { alawWav } from '../helpers/pcmFixtures';

/** Rate of the fixture: A-law telephony audio. */
const SAMPLE_RATE = 8000;

/** Length of the fixture, in seconds. */
const SECONDS = 2.5;

/**
 * The split service over a vault holding the fixture.
 * @returns The service and what it wrote, by path
 */
function createSut(): {
	service: SplitService;
	written: Map<string, ArrayBuffer>;
} {
	const written = new Map<string, ArrayBuffer>();
	const app: App = createMockApp({
		vault: {
			readBinary: jest
				.fn()
				.mockResolvedValue(alawWav(SAMPLE_RATE, SECONDS)),
			adapter: { exists: jest.fn().mockResolvedValue(false) },
			createBinary: jest.fn((path: string, data: ArrayBuffer) => {
				written.set(path, data);
				return Promise.resolve(Object.assign(new TFile(), { path }));
			}),
		},
	}).app;
	return { service: new SplitService(app), written };
}

/** The A-law recording being split. */
function sourceFile(): TFile {
	return Object.assign(new TFile(), {
		path: 'Calls/call.wav',
		name: 'call.wav',
		basename: 'call',
		extension: 'wav',
		parent: { path: 'Calls' },
		stat: { size: 44 + SAMPLE_RATE * SECONDS, ctime: 0, mtime: 0 },
	});
}

describe('a split that streams its source', () => {
	it('writes every part as a 16-bit WAV of exactly the part length', async () => {
		const { service, written } = createSut();

		const outcome = await service.split(
			{
				sourceFile: sourceFile(),
				partSeconds: 1,
				suffix: 'part',
				bitrate: 128000,
				deleteSource: false,
				linkAction: 'none',
			},
			jest.fn(),
		);

		expect(outcome).toEqual({
			status: 'completed',
			partCount: 3,
			firstPartName: 'call-part1.wav',
		});
		// The last part runs to the decoder's end rather than to the plan,
		// so the half second after the last boundary is all there.
		expect(
			[...written.entries()].map(([path, data]) => [
				path,
				defined(parseWavLayout(data)).dataLength / 2,
			]),
		).toEqual([
			['Calls/call-part1.wav', SAMPLE_RATE],
			['Calls/call-part2.wav', SAMPLE_RATE],
			['Calls/call-part3.wav', SAMPLE_RATE / 2],
		]);
	});
});
