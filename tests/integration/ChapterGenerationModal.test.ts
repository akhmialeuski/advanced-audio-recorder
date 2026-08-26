/**
 * Tests the on-demand chapter dialog. It was almost entirely uncovered, which
 * is why its cost estimate could disagree with the Transcribe dialog's by up to
 * 4x without any test noticing. These cover what the dialog is responsible for:
 * the empty state when there is no transcript, the pickers, the estimate coming
 * from the shared step model, and the rule that a run's LLM and profile choices
 * reach the plugin settings only when the user actually generates.
 * @module tests/unit/ChapterGenerationModal.test
 */

import { noSelectedProfiles } from 'src/settings/profiles';
import type { App, TFile } from 'obsidian';
import { ChapterGenerationModal } from 'src/ui/ChapterGenerationModal';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { estimateStepCost, formatUsd } from 'src/transcription/api';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { AutoChapterService } from 'src/chapters/AutoChapterService';
import type { TranscriptLinesSource } from 'src/chapters/transcriptSources';
import { at, defined } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';

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
		geminiModel: 'gemini-2.5-flash',
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

/**
 * What the row with a given name says under it.
 * @param modal - The open dialog
 * @param name - The row's label
 */
function descriptionOf(modal: ChapterGenerationModal, name: string): string {
	const row = [...modal.contentEl.querySelectorAll('.setting-item')].find(
		(el) => el.querySelector('.setting-item-name')?.textContent === name,
	);
	return (
		defined(row, `row ${name}`).querySelector('.setting-item-description')
			?.textContent ?? ''
	);
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
		const { modal } = build({ geminiModel: 'mystery-model' });

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

		expect(settings.chaptersLlmProvider).toBe(LLM_PROVIDER_IDS.GEMINI);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it("commits the run's engine and model when the user generates", async () => {
		const { modal, settings, saveSettings, generate } = build();
		await open(modal);

		const provider = at(dropdowns(modal), 1);
		provider.value = LLM_PROVIDER_IDS.ANTHROPIC;
		provider.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();

		at(buttons(modal), 0).click();

		// The dialog configures chapters, so it moves the chapters engine and
		// leaves post-processing pointing where the user put it.
		expect(settings.chaptersLlmProvider).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
		expect(settings.llmProvider).toBe(LLM_PROVIDER_IDS.GEMINI);
		expect(saveSettings).toHaveBeenCalled();
		expect(generate).toHaveBeenCalledWith(
			file,
			undefined,
			SOURCE,
			expect.any(AbortSignal),
		);
	});

	it('moves only the model of the engine it generates with', async () => {
		// Gemini serves one catalogue for transcription and for prompts alike,
		// so committing every vendor's model let this dialog repoint the id
		// transcription runs on.
		const { modal, settings } = build();
		settings.geminiModel = 'gemini-2.5-pro';
		await open(modal);

		const provider = at(dropdowns(modal), 1);
		provider.value = LLM_PROVIDER_IDS.ANTHROPIC;
		provider.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();

		const model = at(dropdowns(modal), 2);
		model.value = 'claude-sonnet-5';
		model.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();

		at(buttons(modal), 0).click();

		expect(settings.llmAnthropicModel).toBe('claude-sonnet-5');
		expect(settings.geminiModel).toBe('gemini-2.5-pro');
	});

	it('says up front when the engine it would generate with shares its catalogue', async () => {
		// What the previous case cannot prevent: the engine that actually runs
		// has one catalogue for both jobs, so the model committed here is the id
		// transcription reads. That belongs where the choice is made rather than
		// in the next transcription's bill.
		const { modal } = build();
		await open(modal);

		expect(descriptionOf(modal, 'LLM')).toContain(
			'the model picked here is the one transcription runs on too',
		);
	});

	it('says nothing of the kind for an engine that only answers prompts', async () => {
		// Anthropic has no transcription side, so its catalogue is the chapters
		// catalogue and nothing else reads what is picked from it.
		const { modal } = build({
			chaptersLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
		});
		await open(modal);

		expect(descriptionOf(modal, 'LLM')).not.toContain(
			'transcription runs on too',
		);
	});

	it('follows the engine as it is switched, rather than the one it opened on', async () => {
		const { modal } = build({
			chaptersLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
		});
		await open(modal);

		const provider = at(dropdowns(modal), 1);
		provider.value = LLM_PROVIDER_IDS.GEMINI;
		provider.dispatchEvent(new Event('change'));
		await Promise.resolve();
		await Promise.resolve();

		expect(descriptionOf(modal, 'LLM')).toContain(
			'the model picked here is the one transcription runs on too',
		);
	});

	it("commits the run's chapter profile so the shared service reads it", async () => {
		const { modal, settings, generate } = build({
			profiles: [
				{
					id: 'p1',
					kind: 'chapterPrompt',
					name: 'Agenda',
					body: 'By agenda.',
				},
			],
			selectedProfileIds: noSelectedProfiles(),
		});
		await open(modal);

		const profile = at(dropdowns(modal), 0);
		profile.value = 'p1';
		profile.dispatchEvent(new Event('change'));
		await Promise.resolve();

		at(buttons(modal), 0).click();

		expect(settings.selectedProfileIds.chapterPrompt).toBe('p1');
		expect(generate).toHaveBeenCalled();
	});

	it('reuses the transcript it already located instead of re-reading it', async () => {
		const { modal, generate } = build();
		await open(modal);

		at(buttons(modal), 0).click();

		// The service must receive the located source, so it does not scan the
		// sidecar and the notes a second time.
		expect(generate).toHaveBeenCalledWith(
			file,
			undefined,
			SOURCE,
			expect.any(AbortSignal),
		);
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

// The dialog used to commit the choices, close, and leave generation running
// with nothing able to stop it. That is a paid call on a transcript of any
// length, so it stays open while it runs and offers a way out.
describe('a generation the user can stop', () => {
	/** A generate that only settles when its signal aborts. */
	function abortableGenerate(): jest.Mock<Promise<boolean>, unknown[]> {
		return jest.fn(
			(
				_file: unknown,
				_transcript: unknown,
				_preloaded: unknown,
				signal: AbortSignal,
			) =>
				new Promise<boolean>((resolve) => {
					signal.addEventListener('abort', () => {
						resolve(false);
					});
				}),
		) as jest.Mock<Promise<boolean>, unknown[]>;
	}

	/**
	 * Opens the dialog and starts a generation that only ends when its signal
	 * fires, leaving the run in flight for the test to end its own way.
	 * @returns The dialog and the generate double it is waiting on
	 */
	async function generationInFlight(): Promise<{
		modal: ChapterGenerationModal;
		running: jest.Mock<Promise<boolean>, unknown[]>;
	}> {
		const { modal, generate } = build();
		const running = abortableGenerate();
		generate.mockImplementation(running);
		await open(modal);
		at(buttons(modal), 0).click();
		await Promise.resolve();
		return { modal, running };
	}

	/**
	 * The signal the dialog handed the service.
	 * @param running - The generate double it was handed to
	 * @returns That signal
	 */
	function handedSignal(
		running: jest.Mock<Promise<boolean>, unknown[]>,
	): AbortSignal {
		return at(at(running.mock.calls, 0), 3) as AbortSignal;
	}

	it('stays open while the chapters are being generated', async () => {
		const { modal } = await generationInFlight();

		expect(modal.contentEl.textContent).toContain('Generating chapters');
		expect(defined(buttons(modal)[0]).textContent).toBe('Cancel');
	});

	it('aborts the run the signal it handed over', async () => {
		const { modal, running } = await generationInFlight();

		at(buttons(modal), 0).click();
		await Promise.resolve();

		expect(handedSignal(running).aborted).toBe(true);
	});

	// The Cancel button is not the only way out of a dialog: Escape and the
	// window's own close control dismiss it too, and a run whose cancellation
	// only the button could reach kept going - paid, and with nothing left on
	// screen to stop it.
	it('cancels the run when the dialog is dismissed', async () => {
		const { modal, running } = await generationInFlight();

		modal.close();

		expect(handedSignal(running).aborted).toBe(true);
	});

	// A run that answered has nothing left to cancel, and the close that
	// follows it must not look like one.
	it('leaves a finished run alone when it closes itself', async () => {
		const { modal, generate } = build();
		generate.mockResolvedValue(true);
		await open(modal);

		at(buttons(modal), 0).click();
		await flushMicrotasks();

		const signal = at(at(generate.mock.calls, 0), 3) as AbortSignal;
		expect(signal.aborted).toBe(false);
	});

	it('closes itself once the generation is done', async () => {
		const { modal, generate } = build();
		generate.mockResolvedValue(true);
		const close = jest.spyOn(modal, 'close').mockImplementation();
		await open(modal);

		at(buttons(modal), 0).click();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(close).toHaveBeenCalledTimes(1);
	});
});
