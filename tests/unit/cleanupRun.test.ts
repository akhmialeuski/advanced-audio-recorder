/**
 * Tests for one cleanup of a recording from start to finish: the copy is
 * written, linked while the source still resolves, and the source trashed
 * when asked - and what is said when a step after the copy fails.
 * @module tests/unit/cleanupRun.test
 */

import type { TFile } from 'obsidian';
import { cleanUpRecording, describeCleanup } from 'src/cleanup/cleanupRun';
import { AudioProcessingService } from 'src/cleanup/AudioProcessingService';
import { resolveAudioDspConfig } from 'src/cleanup/audioDsp';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { createFile, createMockApp } from '../helpers/createApp';
import { silenceConsole } from '../helpers/doubles';

const OUTPUT = 'Recordings/take-processed.wav';

/**
 * A run over one recording whose processing is stubbed to write the copy.
 * @param options - Whether the source goes, and what is done with the copy
 */
async function run(options: {
	deleteSource: boolean;
	onProcessed?: jest.Mock;
	trashFails?: boolean;
}): Promise<{
	result: Awaited<ReturnType<typeof cleanUpRecording>>;
	trashFile: jest.Mock;
	file: TFile;
}> {
	jest.spyOn(AudioProcessingService.prototype, 'process').mockResolvedValue(
		OUTPUT,
	);
	const trashFile = options.trashFails
		? jest.fn().mockRejectedValue(new Error('locked'))
		: jest.fn().mockResolvedValue(undefined);
	const { app } = createMockApp({ fileManager: { trashFile } });
	const file = createFile('Recordings/take.webm');
	const result = await cleanUpRecording(
		app,
		file,
		resolveAudioDspConfig(DEFAULT_SETTINGS),
		options,
	);
	return { result, trashFile, file };
}

describe('cleaning up a recording', () => {
	it('keeps the source unless it is to go', async () => {
		const { result, trashFile } = await run({ deleteSource: false });

		expect(result).toEqual({ outputPath: OUTPUT, sourceKept: false });
		expect(trashFile).not.toHaveBeenCalled();
	});

	it('links the copy, then trashes the source', async () => {
		const onProcessed = jest.fn();
		const { trashFile, file } = await run({
			deleteSource: true,
			onProcessed,
		});

		expect(onProcessed).toHaveBeenCalledWith({
			outputPath: OUTPUT,
			replaceSource: true,
		});
		expect(trashFile).toHaveBeenCalledWith(file);
		// Linked first, while the source the note embeds still resolves.
		expect(onProcessed.mock.invocationCallOrder[0]).toBeLessThan(
			trashFile.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it('goes on when linking the copy fails, since the copy exists', async () => {
		const warn = silenceConsole('warn');
		const onProcessed = jest.fn().mockRejectedValue(new Error('read-only'));

		const { result } = await run({ deleteSource: true, onProcessed });

		expect(result.sourceKept).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			'[AudioRecorder] Failed to link the processed file into the note:',
			new Error('read-only'),
		);
		warn.mockRestore();
	});

	it('reports a source it could not trash as kept', async () => {
		const warn = silenceConsole('warn');

		const { result } = await run({ deleteSource: true, trashFails: true });

		expect(result).toEqual({ outputPath: OUTPUT, sourceKept: true });
		warn.mockRestore();
	});
});

describe('what a run is reported with', () => {
	it.each([
		{
			sourceKept: false,
			said: `Processed audio saved to ${OUTPUT}`,
		},
		{
			sourceKept: true,
			said: `Processed audio saved to ${OUTPUT}, but the source could not be deleted.`,
		},
	])(
		'says where the copy went, the source kept: $sourceKept',
		({ sourceKept, said }) => {
			expect(describeCleanup({ outputPath: OUTPUT, sourceKept })).toBe(
				said,
			);
		},
	);
});
