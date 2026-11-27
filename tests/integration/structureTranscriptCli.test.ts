/**
 * Tests the command line run of "Structure transcript with a template": the
 * template it picks, what it refuses, and the note it writes.
 * @module tests/integration/structureTranscriptCli.test
 */

import type { FileContext } from 'src/actions/file/FileContext';
import { RecordingOrigin } from 'src/actions/file/RecordingOrigin';
import {
	openStructureTranscript,
	structureTranscriptFromCli,
} from 'src/actions/file/structureTranscript';
import { StructureTranscriptModal } from 'src/ui/StructureTranscriptModal';
import type { Profile } from 'src/settings/profiles';
import { emptyTranscriptSection } from 'src/sidecar/recordingSidecarModel';
import { recordingVault } from '../helpers/recordingVault';
import { modalInstances } from '../mocks/obsidian';

const STANDUP = 'Recordings/standup.webm';
const MEETING = 'Meetings/standup.md';

/** A template with nothing for the model to fill, so no call is made. */
const PLAIN: Profile = {
	id: 'plain',
	kind: 'llmTemplate',
	name: 'Plain',
	body: '### Structured\n\n{{transcript}}',
};

/**
 * The recording, a meeting note of the given text, and the command line's
 * context in it.
 * @param meeting - The meeting note's text
 * @param origin - How the command line reached the recording
 */
function createSut(
	meeting: string,
	origin?: RecordingOrigin,
): ReturnType<typeof recordingVault> & { context: FileContext } {
	const vault = recordingVault({
		recordings: [STANDUP],
		notes: { [MEETING]: meeting },
		// A key, so the engine can be built; no call is made.
		settings: { whisperApiKey: 'sk-test' },
	});
	vault.settings.profiles = [...vault.settings.profiles, PLAIN];
	// The note links the recording, which is how its transcript is found.
	vault.app.metadataCache.resolvedLinks = { [MEETING]: { [STANDUP]: 1 } };
	return {
		...vault,
		context: {
			file: vault.file(STANDUP),
			services: vault.services,
			origin: origin ?? RecordingOrigin.named(vault.file(MEETING)),
		},
	};
}

/** A meeting note holding a transcript with timecode links. */
const WITH_TRANSCRIPT = [
	'![[standup.webm]]',
	'',
	'[[standup.webm#t=0|0:00]] Hello.',
	'',
	'[[standup.webm#t=65|1:05]] Bye.',
].join('\n');

describe('structuring a transcript from the command line', () => {
	it('needs a note to write into', async () => {
		const sut = createSut(WITH_TRANSCRIPT, RecordingOrigin.named(null));

		await expect(structureTranscriptFromCli(sut.context, {})).resolves.toBe(
			'Name the note to write into with note=<path>.',
		);
	});

	it.each([
		[
			'the note open in Obsidian',
			MEETING,
			`Structured standup.webm with "Plain" into ${MEETING}.`,
		],
		[
			'never the recording itself',
			STANDUP,
			'Name the note to write into with note=<path>.',
		],
	])(
		'writes into %s when no note is named',
		async (_label, active, answer) => {
			const sut = createSut(WITH_TRANSCRIPT, RecordingOrigin.direct());
			jest.spyOn(sut.app.workspace, 'getActiveFile').mockReturnValue(
				sut.file(active),
			);

			await expect(
				structureTranscriptFromCli(sut.context, { template: 'Plain' }),
			).resolves.toBe(answer);
		},
	);

	it('needs a note named when none is open either', async () => {
		const sut = createSut(WITH_TRANSCRIPT, RecordingOrigin.direct());
		jest.spyOn(sut.app.workspace, 'getActiveFile').mockReturnValue(null);

		await expect(structureTranscriptFromCli(sut.context, {})).resolves.toBe(
			'Name the note to write into with note=<path>.',
		);
	});

	it('names the templates there are when the one typed is not among them', async () => {
		const sut = createSut(WITH_TRANSCRIPT);

		await expect(
			structureTranscriptFromCli(sut.context, { template: 'Retro' }),
		).resolves.toMatch(
			/^No note template is called "Retro"\. There are: .*Plain/,
		);
	});

	it('asks for a transcription first when there is no transcript', async () => {
		const sut = createSut('![[standup.webm]]');

		await expect(
			structureTranscriptFromCli(sut.context, { template: 'plain' }),
		).resolves.toBe(
			`No transcript found for ${STANDUP}. Transcribe it first.`,
		);
	});

	it('writes the note with the template named, whatever its case', async () => {
		const sut = createSut(WITH_TRANSCRIPT);

		const answer = await structureTranscriptFromCli(sut.context, {
			template: 'PLAIN',
		});

		expect(answer).toBe(
			`Structured standup.webm with "Plain" into ${MEETING}.`,
		);
		const text = await sut.app.vault.read(sut.file(MEETING));
		expect(text).toContain('### Structured');
	});

	it('applies the template the recording was last structured with when none is named', async () => {
		const sut = createSut(WITH_TRANSCRIPT);
		jest.mocked(
			sut.services.recordingSidecar.getTranscript,
		).mockResolvedValue({
			...emptyTranscriptSection(),
			appliedTemplate: {
				profileId: PLAIN.id,
				name: 'Plain',
				appliedAt: 't',
			},
		});

		await expect(structureTranscriptFromCli(sut.context, {})).resolves.toBe(
			`Structured standup.webm with "Plain" into ${MEETING}.`,
		);
	});

	it('falls back to the first template when the sidecar cannot be read', async () => {
		const sut = createSut(WITH_TRANSCRIPT);
		sut.settings.profiles = [PLAIN];
		jest.mocked(
			sut.services.recordingSidecar.getTranscript,
		).mockRejectedValue(new Error('unreadable'));

		await expect(structureTranscriptFromCli(sut.context, {})).resolves.toBe(
			`Structured standup.webm with "Plain" into ${MEETING}.`,
		);
	});

	it('says there is no template when the settings hold none', async () => {
		const sut = createSut(WITH_TRANSCRIPT);
		sut.settings.profiles = [];

		await expect(structureTranscriptFromCli(sut.context, {})).resolves.toBe(
			'There is no note template yet.',
		);
		await expect(
			structureTranscriptFromCli(sut.context, { template: 'Plain' }),
		).resolves.toBe('No note template is called "Plain". There are: none.');
	});
});

describe('opening the dialog', () => {
	it('opens the dialog for the recording', () => {
		const sut = createSut(WITH_TRANSCRIPT);

		openStructureTranscript(sut.context);

		expect(modalInstances.at(-1)).toBeInstanceOf(StructureTranscriptModal);
	});
});
