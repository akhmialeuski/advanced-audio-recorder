/**
 * Tests for the choices one chapter generation is made with: what a typed
 * profile, engine and model become in the run's settings, what is refused,
 * and how the run's choices become the stored defaults.
 * @module tests/integration/chapterRunSettings.test
 */

import {
	applyChapterRunChoices,
	commitChapterRunSettings,
} from 'src/chapters/chapterRunSettings';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { jobLlmVendor, LlmJobId } from 'src/transcription/llm/vendors';
import {
	createProfile,
	ProfileKindId,
	selectedProfileId,
} from 'src/settings/profiles';

/** Settings with one chapter profile, as a fresh vault plus a lecture one. */
function createSut(): ReturnType<typeof mergeSettings> {
	const settings = mergeSettings({});
	settings.profiles = [
		...settings.profiles,
		createProfile(ProfileKindId.ChapterPrompt, 'Lecture'),
	];
	return settings;
}

/** The model the chapter job runs on. */
const chapterModel = (settings: ReturnType<typeof mergeSettings>): string =>
	jobLlmVendor(settings, LlmJobId.AutoChapters).settings.model(settings);

describe('applying typed choices to a run', () => {
	it('picks the profile by its name, whatever the case', () => {
		const run = createSut();

		expect(applyChapterRunChoices(run, { profile: 'LECTURE' })).toBeNull();

		expect(selectedProfileId(run, ProfileKindId.ChapterPrompt)).toBe(
			run.profiles.find((profile) => profile.name === 'Lecture')?.id,
		);
	});

	it('picks no profile with none', () => {
		const run = createSut();

		applyChapterRunChoices(run, { profile: 'none' });

		expect(selectedProfileId(run, ProfileKindId.ChapterPrompt)).toBe('');
	});

	it('switches the engine', () => {
		const run = createSut();

		expect(
			applyChapterRunChoices(run, { llm: LLM_PROVIDER_IDS.ANTHROPIC }),
		).toBeNull();

		expect(run.chaptersLlmProvider).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
	});

	it('switches the model within the engine it switched to', () => {
		const run = createSut();
		const switched = createSut();
		applyChapterRunChoices(switched, { llm: LLM_PROVIDER_IDS.ANTHROPIC });
		const model = jobLlmVendor(
			switched,
			LlmJobId.AutoChapters,
		).settings.models(switched)[1] as string;

		expect(
			applyChapterRunChoices(run, {
				llm: LLM_PROVIDER_IDS.ANTHROPIC,
				model,
			}),
		).toBeNull();

		expect(chapterModel(run)).toBe(model);
	});

	it('changes nothing with nothing typed', () => {
		const run = createSut();
		const before = JSON.stringify(run);

		applyChapterRunChoices(run, {});

		expect(JSON.stringify(run)).toBe(before);
	});

	it.each([
		{
			name: 'a profile nobody made',
			choices: { profile: 'Podcast' },
			refusal:
				/^No profile named "Podcast"\. The ones to choose from: none, /,
		},
		{
			name: 'an engine that answers no prompts',
			choices: { llm: 'whisper' },
			refusal: /^llm=whisper is not one of: openai-compatible, /,
		},
		{
			name: 'a model the engine does not list',
			choices: { model: 'no-such-model' },
			refusal: /^model=no-such-model is not in the .* model list: /,
		},
	])('refuses $name', ({ choices, refusal }) => {
		expect(applyChapterRunChoices(createSut(), choices)).toMatch(refusal);
	});
});

describe('making a run the default', () => {
	it('writes the engine, its model and the profile into the settings', () => {
		const live = createSut();
		const run = createSut();
		applyChapterRunChoices(run, {
			llm: LLM_PROVIDER_IDS.ANTHROPIC,
			profile: 'none',
		});

		commitChapterRunSettings(live, run);

		expect(live.chaptersLlmProvider).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
		expect(chapterModel(live)).toBe(chapterModel(run));
		expect(selectedProfileId(live, ProfileKindId.ChapterPrompt)).toBe('');
	});
});
