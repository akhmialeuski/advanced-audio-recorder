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
import { asMockApp } from '../helpers/obsidianMock';

const STANDUP = 'Recordings/standup.webm';
const MEETING = 'Meetings/standup.md';
/** The note a template writes apart, next to the recording. */
const OWN_NOTE = 'Recordings/standup - Plain.md';

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
	it('writes into the note open in Obsidian when no note is named', async () => {
		const sut = createSut(WITH_TRANSCRIPT, RecordingOrigin.direct());
		jest.spyOn(sut.app.workspace, 'getActiveFile').mockReturnValue(
			sut.file(MEETING),
		);

		await expect(
			structureTranscriptFromCli(sut.context, { template: 'Plain' }),
		).resolves.toBe(
			`Structured standup.webm with "Plain" into ${MEETING}.`,
		);
	});

	it.each([
		['no note is named', RecordingOrigin.named(null), undefined],
		['the recording itself is open', RecordingOrigin.direct(), STANDUP],
		['nothing is open', RecordingOrigin.direct(), null],
	])(
		'writes a note of its own next to the recording when %s',
		async (_label, origin, active) => {
			const sut = createSut(WITH_TRANSCRIPT, origin);
			if (active !== undefined) {
				jest.spyOn(sut.app.workspace, 'getActiveFile').mockReturnValue(
					active === null ? null : sut.file(active),
				);
			}

			await expect(
				structureTranscriptFromCli(sut.context, { template: 'Plain' }),
			).resolves.toBe(
				`Structured standup.webm with "Plain" into ${OWN_NOTE}.`,
			);
			const text = await sut.app.vault.read(sut.file(OWN_NOTE));
			expect(text).toContain('### Structured');
		},
	);

	it('writes the note apart and links it when output=separate', async () => {
		const sut = createSut(WITH_TRANSCRIPT);

		await expect(
			structureTranscriptFromCli(sut.context, {
				template: 'Plain',
				output: 'Separate',
			}),
		).resolves.toBe(
			`Structured standup.webm with "Plain" into ${OWN_NOTE}.`,
		);
		const meeting = await sut.app.vault.read(sut.file(MEETING));
		expect(meeting).toContain('[[standup - Plain]]');
		expect(meeting).not.toContain('### Structured');
	});

	it('names the outputs there are when the one typed is not among them', async () => {
		const sut = createSut(WITH_TRANSCRIPT);

		await expect(
			structureTranscriptFromCli(sut.context, { output: 'daily' }),
		).resolves.toBe('output= takes note or separate.');
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

	it('applies the template the note names when none is named on the command line', async () => {
		const sut = createSut(WITH_TRANSCRIPT);
		sut.settings.profiles = [
			{ ...PLAIN, id: 'other', name: 'Other' },
			PLAIN,
		];
		const { getFileCache } = asMockApp(sut.app).metadataCache;
		const cacheOf = getFileCache.getMockImplementation();
		// The note's cache as the vault builds it, with the property added.
		getFileCache.mockImplementation((note) => ({
			...(cacheOf?.(note) as object),
			...(note.path === MEETING
				? { frontmatter: { 'note-template': 'plain' } }
				: {}),
		}));

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
