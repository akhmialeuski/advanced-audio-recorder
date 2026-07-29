/**
 * Tests the on-demand chapter dialog. It was almost entirely uncovered, which
 * is why its cost estimate could disagree with the Transcribe dialog's by up to
 * 4x without any test noticing. These cover what the dialog is responsible for:
 * the empty state when there is no transcript, the pickers, the estimate coming
 * from the shared step model, and the rule that a run's LLM and profile choices
 * reach the plugin settings only when the user actually generates.
 * @module tests/unit/ChapterGenerationModal.test
 */

import type { App, TFile } from 'obsidian';
import { ChapterGenerationModal } from 'src/ui/ChapterGenerationModal';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { estimateStepCost, formatUsd } from 'src/transcription/api';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { AutoChapterService } from 'src/chapters/AutoChapterService';
import type { TranscriptLinesSource } from 'src/chapters/transcriptSources';
import { at, defined } from '../helpers/assertions';

const loadTranscriptLines = jest.fn();
jest.mock('src/chapters/transcriptSources', () => ({
	loadTranscriptLines: (...args: unknown[]): unknown =>
		loadTranscriptLines(...args),
}));

/** A transcript spanning ten minutes, enough to price a real estimate. */
const SOURCE: TranscriptLinesSource = {
	lines: [
		{ time: 0, text: 'hello' },
		{ time: 600, text: 'goodbye' },
	],
	origin: 'rec.json',
};

const file = { name: 'rec.wav', path: 'rec.wav' } as TFile;
const app = {} as App;

/** Builds the dialog with stubbed collaborators and a settings object. */
function build(overrides: Partial<AudioRecorderSettings> = {}) {
	const settings = mergeSettings({
		llmProvider: LLM_PROVIDER_IDS.GEMINI,
		llmGeminiModel: 'gemini-2.5-flash',
		llmMaxTokens: 32000,
		...overrides,
	});
	const saveSettings = jest.fn<Promise<void>, []>().mockResolvedValue();
	const generate = jest.fn<Promise<boolean>, unknown[]>();
	const hasExistingChapters = jest.fn<Promise<boolean>, [TFile]>();
	hasExistingChapters.mockResolvedValue(false);
	const autoChapters = {
		generate,
		hasExistingChapters,
	} as unknown as AutoChapterService;
	const modal = new ChapterGenerationModal(app, file, {
		getSettings: () => settings,
		saveSettings,
		autoChapters,
		sidecar: { getTranscript: jest.fn() },
	});
	return { modal, settings, saveSettings, generate, hasExistingChapters };
}

/** Opens the dialog and lets its async render settle. */
async function open(modal: ChapterGenerationModal): Promise<void> {
	modal.onOpen();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

/** The dialog's buttons, in render order. */
function buttons(modal: ChapterGenerationModal): HTMLButtonElement[] {
	return [...modal.contentEl.querySelectorAll('button')];
}

/** The dialog's dropdowns, in render order. */
function dropdowns(modal: ChapterGenerationModal): HTMLSelectElement[] {
	return [...modal.contentEl.querySelectorAll('select')];
}

beforeEach(() => {
	loadTranscriptLines.mockResolvedValue(SOURCE);
});

describe('ChapterGenerationModal without a transcript', () => {
	it('explains there is nothing to chapter and offers only Close', async () => {
		loadTranscriptLines.mockResolvedValue(null);
		const { modal, generate } = build();

		await open(modal);

		expect(modal.contentEl.textContent).toContain('No transcript found');
		const labels = buttons(modal).map((b) => b.textContent);
		expect(labels).toEqual(['Close']);
		expect(generate).not.toHaveBeenCalled();
	});

	it('treats an empty line list the same as no transcript', async () => {
		loadTranscriptLines.mockResolvedValue({ lines: [], origin: 'x' });
		const { modal } = build();

		await open(modal);

		expect(modal.contentEl.textContent).toContain('No transcript found');
	});
});

describe('ChapterGenerationModal cost estimate', () => {
	it('shows the same number the shared auto-chapters step prices', async () => {
		const { modal, settings } = build();

		await open(modal);

		// The dialog must not carry its own formula: pricing it as a
		// post-processing pass made this number disagree with the Transcribe
		// dialog and move with the unrelated LLM task setting.
		const expected = defined(
			estimateStepCost('autoChapters', settings, 600).usd,
		);
		expect(modal.contentEl.textContent).toContain(formatUsd(expected));
	});

	it('does not move with the post-processing task', async () => {
		const cleanup = build({ llmPostProcessTask: 'cleanup' });
		await open(cleanup.modal);
		const summary = build({ llmPostProcessTask: 'summary' });
		await open(summary.modal);

		const amount = (modal: ChapterGenerationModal): string =>
			defined(
				/about (\$[\d.]+|<\$0\.01)/.exec(
					modal.contentEl.textContent ?? '',
				),
			)[1] ?? '';
		expect(amount(summary.modal)).toBe(amount(cleanup.modal));
	});

	it('says so when the selected model has no built-in rate', async () => {
		const { modal } = build({ llmGeminiModel: 'mystery-model' });

		await open(modal);

		expect(modal.contentEl.textContent).toContain('not available');
	});

	it('is hidden when cost estimates are turned off', async () => {
		const { modal } = build({ transcriptionShowCostEstimates: false });

		await open(modal);

		expect(modal.contentEl.textContent).not.toContain('Estimated cost');
	});
});

describe('ChapterGenerationModal run settings', () => {
	it('leaves the plugin settings untouched until the user generates', async () => {
		const { modal, settings, saveSettings, generate } = build();
		await open(modal);

		// Repoint the provider, then close without generating.
		const provider = at(dropdowns(modal), 1);
		provider.value = LLM_PROVIDER_IDS.ANTHROPIC;
		provider.dispatchEvent(new Event('change'));
		await Promise.resolve();
		modal.onClose();

		expect(settings.llmProvider).toBe(LLM_PROVIDER_IDS.GEMINI);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it("commits the run's provider and model when the user generates", async () => {
		const { modal, settings, saveSettings, generate } = build();
		await open(modal);

		const provider = at(dropdowns(modal), 1);
		provider.value = LLM_PROVIDER_IDS.ANTHROPIC;
		provider.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();

		at(buttons(modal), 0).click();

		expect(settings.llmProvider).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
		expect(saveSettings).toHaveBeenCalled();
		expect(generate).toHaveBeenCalledWith(file, undefined, SOURCE);
	});

	it("commits the run's chapter profile so the shared service reads it", async () => {
		const { modal, settings, generate } = build({
			transcriptionChapterPromptProfiles: [
				{ id: 'p1', name: 'Agenda', prompt: 'By agenda.' },
			],
			transcriptionChapterPromptProfileId: '',
		});
		await open(modal);

		const profile = at(dropdowns(modal), 0);
		profile.value = 'p1';
		profile.dispatchEvent(new Event('change'));
		await Promise.resolve();

		at(buttons(modal), 0).click();

		expect(settings.transcriptionChapterPromptProfileId).toBe('p1');
		expect(generate).toHaveBeenCalled();
	});

	it('reuses the transcript it already located instead of re-reading it', async () => {
		const { modal, generate } = build();
		await open(modal);

		at(buttons(modal), 0).click();

		// The service must receive the located source, so it does not scan the
		// sidecar and the notes a second time.
		expect(generate).toHaveBeenCalledWith(file, undefined, SOURCE);
		expect(loadTranscriptLines).toHaveBeenCalledTimes(1);
	});
});

describe('ChapterGenerationModal with existing chapters', () => {
	it('offers Regenerate and confirms before replacing them', async () => {
		const { modal, hasExistingChapters, generate } = build();
		hasExistingChapters.mockResolvedValue(true);

		await open(modal);

		expect(at(buttons(modal), 0).textContent).toBe('Regenerate');
		at(buttons(modal), 0).click();
		// Generation waits behind the confirmation dialog.
		expect(generate).not.toHaveBeenCalled();
	});
});
