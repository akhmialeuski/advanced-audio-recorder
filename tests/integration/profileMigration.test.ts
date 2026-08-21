/**
 * Tests the upgrade from the profile lists this plugin used to keep apart.
 *
 * A config written before the unification holds a glossary list, a chapter
 * prompt list, a roster list, and three flat post-processing prompts, none of
 * which this version reads. The upgrade has to be invisible: the same
 * profiles, still selected, still identified by the ids a recording's sidecar
 * wrote down, and the prompt a user tuned still running - as a profile they
 * can now keep several of. The superseded fields must also leave the merged
 * object, or the next save would write them back and the migration would run
 * again over whatever changed since.
 * @module tests/integration/profileMigration.test
 */

import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	profilesOfKind,
	type Profile,
	type ProfileKindId,
} from 'src/settings/profiles';
import {
	DEFAULT_LLM_CLEANUP_PROMPT,
	DEFAULT_LLM_CUSTOM_PROFILE_ID,
} from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** A config as the version before the unification wrote it. */
const legacyConfig = () => ({
	transcriptionSpeakerProfiles: [
		{ id: 's1', name: 'Weekly sync', participants: ['Maria', 'Ivan'] },
	],
	transcriptionSpeakerProfileId: 's1',
	transcriptionDictionaryProfiles: [
		{ id: 'd1', name: 'Standup', terms: 'gRPC\nkubectl' },
		{ id: 'd2', name: 'Legal', terms: 'affidavit' },
	],
	transcriptionDictionaryProfileId: 'd2',
	transcriptionChapterPromptProfiles: [
		{ id: 'default', name: 'Default', prompt: 'Split by agenda item.' },
	],
	transcriptionChapterPromptProfileId: 'default',
	llmCleanupPrompt: 'Fix the punctuation, nothing else.',
	llmSummaryPrompt: 'List the decisions only.',
	llmCustomInstruction: 'Rewrite as a memo.',
});

/** The bodies of one kind, in stored order. */
const bodies = (settings: AudioRecorderSettings, kind: ProfileKindId) =>
	profilesOfKind(settings.profiles, kind).map((profile) => profile.body);

/** The profile of a kind that the merged config applies. */
const inUse = (
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
): Profile | undefined =>
	settings.profiles.find(
		(profile) => profile.id === settings.selectedProfileIds[kind],
	);

describe('upgrading a pre-unification config', () => {
	it('carries every list over with its ids, order, and selection', () => {
		const result = mergeSettings(legacyConfig());

		expect(profilesOfKind(result.profiles, 'dictionary')).toEqual([
			{
				id: 'd1',
				kind: 'dictionary',
				name: 'Standup',
				body: 'gRPC\nkubectl',
			},
			{ id: 'd2', kind: 'dictionary', name: 'Legal', body: 'affidavit' },
		]);
		// The id is what a selection and a recording's sidecar name, so it is
		// the one thing the move may not change.
		expect(result.selectedProfileIds.dictionary).toBe('d2');
		expect(result.selectedProfileIds.participants).toBe('s1');
		expect(result.selectedProfileIds.chapterPrompt).toBe('default');
	});

	it('stores a roster as the text its editor shows', () => {
		// The roster used to be stored parsed; a profile body is what the user
		// edits, so it arrives one name per line and reads back the same names.
		expect(bodies(mergeSettings(legacyConfig()), 'participants')).toEqual([
			'Maria\nIvan',
		]);
	});

	it('moves each tuned prompt into the seeded default profile of its task', () => {
		const result = mergeSettings(legacyConfig());

		// The prompt the user tuned is what keeps running; it is now one entry
		// of a catalogue rather than the only text there was.
		expect(inUse(result, 'llmCleanup')?.body).toBe(
			'Fix the punctuation, nothing else.',
		);
		expect(inUse(result, 'llmSummary')?.body).toBe(
			'List the decisions only.',
		);
		expect(inUse(result, 'llmCustom')?.body).toBe('Rewrite as a memo.');
		expect(inUse(result, 'llmCleanup')?.name).toBe('Default');
		expect(profilesOfKind(result.profiles, 'llmCleanup')).toHaveLength(1);
	});

	it('carries a prompt the user had emptied, rather than seeding one back', () => {
		// Emptying the field was how a user asked for the task's built-in
		// behaviour - for the custom task, the neutral instruction. Reading
		// blank as "nothing stored" would hand them a prompt they had
		// deliberately cleared, and the custom pass would start rewriting
		// transcripts as Markdown notes on its own.
		const result = mergeSettings({
			...legacyConfig(),
			llmCustomInstruction: '',
			llmCleanupPrompt: '   ',
		});

		expect(inUse(result, 'llmCustom')?.body).toBe('');
		expect(inUse(result, 'llmCleanup')?.body).toBe('   ');
	});

	it('leaves the built-in prompts alone for a config that never edited them', () => {
		const result = mergeSettings({});

		expect(inUse(result, 'llmCleanup')?.body).toBe(
			DEFAULT_LLM_CLEANUP_PROMPT,
		);
		expect(result.selectedProfileIds.llmCustom).toBe(
			DEFAULT_LLM_CUSTOM_PROFILE_ID,
		);
	});

	it('strips every superseded field so a save cannot write it back', () => {
		const record = mergeSettings(legacyConfig()) as unknown as Record<
			string,
			unknown
		>;

		for (const key of [
			'transcriptionSpeakerProfiles',
			'transcriptionSpeakerProfileId',
			'transcriptionDictionaryProfiles',
			'transcriptionDictionaryProfileId',
			'transcriptionChapterPromptProfiles',
			'transcriptionChapterPromptProfileId',
			'llmCleanupPrompt',
			'llmSummaryPrompt',
			'llmCustomInstruction',
		]) {
			expect(record).not.toHaveProperty(key);
		}
	});

	it('drops a stored profile a hand edit left unusable', () => {
		// A profile with no id is one no selection can name and no page can
		// address; dropping it beats loading a catalogue that cannot be used.
		const result = mergeSettings({
			transcriptionDictionaryProfiles: [
				{ id: '', name: 'No id', terms: 'x' },
				{ id: 'ok', name: 'Fine', terms: 'y' },
			] as never,
		});

		expect(bodies(result, 'dictionary')).toEqual(['y']);
	});

	it('drops unified entries a hand edit left unusable, and unknown kinds', () => {
		// data.json is text on disk: an entry with no kind this version knows,
		// or with no id or name, is one no catalogue can show and no selection
		// can name, so the load leaves it behind rather than carrying it.
		const result = mergeSettings({
			profiles: [
				{ id: 'a', kind: 'glossary', name: 'Old kind', body: 'x' },
				{ id: '', kind: 'dictionary', name: 'No id', body: 'y' },
				{ id: 'c', kind: 'dictionary', name: '', body: 'z' },
				'not a profile at all',
				{ id: 'd', kind: 'dictionary', name: 'Fine', body: 'w' },
			] as never,
			selectedProfileIds: { dictionary: 'd', llmCleanup: 7 } as never,
		});

		expect(bodies(result, 'dictionary')).toEqual(['w']);
		expect(result.selectedProfileIds.dictionary).toBe('d');
		// A selection that is not even text reads as none rather than throwing
		// on the next comparison.
		expect(result.selectedProfileIds.llmCleanup).toBe('');
	});

	it('survives a legacy list that is not a list, or holds things that are not profiles', () => {
		// The old fields are read from disk, not from a type: a corrupted or
		// hand-edited data.json must degrade to a shorter catalogue rather
		// than throw on load, which would reset every setting to its default.
		const result = mergeSettings({
			transcriptionDictionaryProfiles: 'not a list' as never,
			transcriptionSpeakerProfiles: [
				'not a profile',
				{ id: 's1', name: 'Weekly sync', participants: ['Maria'] },
			] as never,
			transcriptionSpeakerProfileId: 's1',
		});

		expect(bodies(result, 'dictionary')).toEqual([]);
		expect(bodies(result, 'participants')).toEqual(['Maria']);
		expect(result.selectedProfileIds.participants).toBe('s1');
	});

	it('leaves a config this version already wrote exactly as it is', () => {
		// Rolling forward twice must not re-run the migration over profiles the
		// user has edited since the first upgrade.
		const once = mergeSettings(legacyConfig());
		const twice = mergeSettings(once);

		expect(twice.profiles).toEqual(once.profiles);
		expect(twice.selectedProfileIds).toEqual(once.selectedProfileIds);
	});

	it('keeps a unified list when a legacy field lingers beside it', () => {
		// A downgrade and a re-upgrade can leave both shapes in data.json; the
		// unified list is the one this version wrote, so it wins.
		const result = mergeSettings({
			profiles: [
				{ id: 'k', kind: 'dictionary', name: 'Kept', body: 'X' },
			],
			selectedProfileIds: { dictionary: 'k' },
			transcriptionDictionaryProfiles: [
				{ id: 'old', name: 'Stale', terms: 'Y' },
			],
			transcriptionDictionaryProfileId: 'old',
			llmCleanupPrompt: 'stale prompt',
		});

		expect(bodies(result, 'dictionary')).toEqual(['X']);
		expect(result.selectedProfileIds.dictionary).toBe('k');
		expect(bodies(result, 'llmCleanup')).not.toContain('stale prompt');
	});
});
