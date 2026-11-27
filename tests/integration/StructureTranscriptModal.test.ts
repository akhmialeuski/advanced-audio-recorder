/**
 * Tests the dialog that structures a recording's existing transcript with a
 * note template: what it asks for first when something is missing, the
 * template it opens on, the estimate, and the run it hands the structurer.
 * @module tests/integration/StructureTranscriptModal.test
 */

import { App, type TFile } from 'obsidian';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId, type Profile } from 'src/settings/profiles';
import type { TranscriptStructurer } from 'src/transcription/TranscriptStructurer';
import {
	StructureTranscriptModal,
	initialTemplateId,
} from 'src/ui/StructureTranscriptModal';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';
import { tenMinuteSource } from '../helpers/transcriptFixtures';
import { noticeMessages } from '../mocks/obsidian';
import { asMockApp } from '../helpers/obsidianMock';

const loadTranscriptLines = jest.fn();
jest.mock('src/chapters/transcriptSources', () => ({
	loadTranscriptLines: (...args: unknown[]): unknown =>
		loadTranscriptLines(...args),
}));

/** Ten minutes of transcript. */
const SOURCE = tenMinuteSource('Anna: hello', 'Ben: goodbye');

const file = { name: 'rec.webm', path: 'rec.webm' } as TFile;
const app = new App();

/** Two templates of the user's own. */
const TEMPLATES: Profile[] = [
	{
		id: 'a',
		kind: 'llmTemplate',
		name: 'Sync',
		body: '{{#part "s"}}S{{/part}}',
	},
	{
		id: 'b',
		kind: 'llmTemplate',
		name: 'Review',
		body: '{{#part "r"}}R{{/part}}',
	},
];

/**
 * The dialog over stubbed collaborators.
 * @param options - The note it writes into, the template last applied, and
 *   settings over the defaults
 */
function build(
	options: {
		notePath?: string;
		applied?: string;
		profiles?: Profile[];
		settings?: Partial<AudioRecorderSettings>;
	} = {},
) {
	const settings = mergeSettings({
		transcriptionShowCostEstimates: true,
		...options.settings,
	});
	settings.profiles = options.profiles ?? TEMPLATES;
	const structure = jest
		.fn()
		.mockResolvedValue({ written: true, message: 'Structured.' });
	const getTranscript = jest.fn().mockResolvedValue({
		...(options.applied
			? {
					appliedTemplate: {
						profileId: options.applied,
						name: 'x',
						appliedAt: '2026-11-26T00:00:00Z',
					},
				}
			: {}),
	});
	const modal = new StructureTranscriptModal(app, file, {
		getSettings: () => settings,
		structurer: { structure } as unknown as TranscriptStructurer,
		sidecar: { getTranscript },
		notePath: options.notePath ?? 'Meetings/Sync.md',
	});
	return { modal, settings, structure };
}

/**
 * Opens the dialog and lets it read what it needs.
 * @param modal - The dialog
 */
async function open(modal: StructureTranscriptModal): Promise<void> {
	modal.onOpen();
	await flushMicrotasks();
}

/** The labels of the dialog's buttons. */
function buttons(modal: StructureTranscriptModal): HTMLButtonElement[] {
	return [...modal.contentEl.querySelectorAll('button')];
}

beforeEach(() => {
	loadTranscriptLines.mockResolvedValue(SOURCE);
});

describe('initialTemplateId', () => {
	it('opens on the template last applied, else the selected one, else the first', () => {
		const settings = mergeSettings({});
		settings.profiles = TEMPLATES;

		expect(initialTemplateId(settings, 'b')).toBe('b');
		expect(initialTemplateId(settings, 'gone')).toBe('a');
		setSelectedProfileId(settings, 'llmTemplate', 'b');
		expect(initialTemplateId(settings, undefined)).toBe('b');
		settings.profiles = [];
		expect(initialTemplateId(settings, 'b')).toBe('');
	});

	it('opens on the template a rule of the note calls for before any other', () => {
		const settings = mergeSettings({});
		settings.profiles = TEMPLATES;

		expect(initialTemplateId(settings, 'a', 'b')).toBe('b');
		expect(initialTemplateId(settings, 'a', 'gone')).toBe('a');
	});
});

describe('StructureTranscriptModal', () => {
	it.each([
		[{ lines: [] }, {}, 'No transcript found for this recording.'],
		[SOURCE, { profiles: [] }, 'There is no note template yet.'],
	])('asks for what is missing first', async (source, options, text) => {
		loadTranscriptLines.mockResolvedValue({ ...source, origin: 'x' });
		const { modal, structure } = build(options);

		await open(modal);

		expect(modal.contentEl.textContent).toContain(text);
		expect(buttons(modal).map((button) => button.textContent)).toEqual([
			'Close',
		]);
		expect(structure).not.toHaveBeenCalled();
	});

	it('opens on the template the recording was structured with, and prices it', async () => {
		const { modal } = build({ applied: 'b' });

		await open(modal);

		expect(modal.contentEl.querySelector('select')?.value).toBe('b');
		expect(modal.contentEl.textContent).toContain(
			'Inserted into Meetings/Sync.md.',
		);
		expect(modal.contentEl.textContent).toContain('Estimated cost:');
		expect(modal.contentEl.textContent).toContain('10:00 transcript');
	});

	it('opens on the template the folder of the note calls for, and says why', async () => {
		asMockApp(app).vault.seed([{ path: 'Reviews/q3.md', content: '' }]);
		const { modal } = build({
			applied: 'a',
			notePath: 'Reviews/q3.md',
			profiles: [
				at(TEMPLATES, 0),
				{ ...at(TEMPLATES, 1), routeFolder: 'Reviews' },
			],
		});

		await open(modal);

		expect(modal.contentEl.querySelector('select')?.value).toBe('b');
		expect(modal.contentEl.textContent).toContain(
			'Applies, picked by the folder Reviews.',
		);
	});

	it('says so when the selected model has no built-in rate', async () => {
		const { modal } = build({
			settings: {
				llmProvider: LLM_PROVIDER_IDS.GEMINI,
				geminiModel: 'mystery-model',
			},
		});

		await open(modal);

		expect(modal.contentEl.textContent).toContain(
			'Estimated cost: not available for the selected LLM model (10:00 transcript).',
		);
	});

	it('shows no estimate when cost estimates are turned off', async () => {
		const { modal } = build({
			settings: { transcriptionShowCostEstimates: false },
		});

		await open(modal);

		expect(modal.contentEl.textContent).not.toContain('Estimated cost');
	});

	it('writes a note of its own when the recording has no note', async () => {
		const { modal } = build({ notePath: '' });

		await open(modal);

		expect(modal.contentEl.textContent).toContain(
			'Written as a note of its own next to rec.webm.',
		);
		expect(modal.contentEl.querySelectorAll('select')).toHaveLength(1);
	});

	it('writes the note apart for this run when asked, linked from the note', async () => {
		const { modal, structure } = build();
		await open(modal);

		const output = at([...modal.contentEl.querySelectorAll('select')], 1);
		output.value = 'separate';
		output.dispatchEvent(new Event('change'));
		await flushMicrotasks();

		expect(modal.contentEl.textContent).toContain(
			'Written as a note of its own next to rec.webm, linked from Meetings/Sync.md.',
		);
		at(buttons(modal), 0).click();
		await flushMicrotasks();
		expect(structure).toHaveBeenCalledWith(
			expect.objectContaining({ output: 'separate' }),
		);
	});

	it('structures with the template picked and tells the outcome', async () => {
		const { modal, structure } = build();
		await open(modal);
		const select = modal.contentEl.querySelector('select');
		if (select) {
			select.value = 'b';
			select.dispatchEvent(new Event('change'));
		}
		await flushMicrotasks();

		buttons(modal)
			.find((button) => button.textContent === 'Structure')
			?.click();
		await flushMicrotasks();

		expect(structure).toHaveBeenCalledWith(
			expect.objectContaining({
				file,
				notePath: 'Meetings/Sync.md',
				templateId: 'b',
				source: SOURCE,
			}),
		);
		expect(noticeMessages()).toContain('Structured.');
	});

	it('cancels the run in flight when the dialog closes', async () => {
		const { modal, structure } = build();
		let signal: AbortSignal | undefined;
		structure.mockImplementation((request: { signal: AbortSignal }) => {
			signal = request.signal;
			return new Promise(() => undefined);
		});
		await open(modal);
		buttons(modal)
			.find((button) => button.textContent === 'Structure')
			?.click();
		await flushMicrotasks();

		expect(modal.contentEl.textContent).toContain(
			'Structuring the transcript',
		);
		modal.onClose();

		expect(signal?.aborted).toBe(true);
	});
});
