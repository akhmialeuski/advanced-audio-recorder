/**
 * Tests for the participant-profile helpers used by the speaker rename dialog.
 */

import type { SpeakerProfile } from 'src/settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	createSpeakerProfile,
	normalizeParticipants,
	participantsOf,
	resolveRunParticipants,
	SPEAKER_PROFILES,
} from 'src/settings/speakerProfiles';
import { mergeSettings } from 'src/settings/settingsSerialization';

describe('speakerProfiles', () => {
	describe('normalizeParticipants', () => {
		it('trims, drops blanks, and deduplicates preserving order', () => {
			expect(
				normalizeParticipants([' Alex ', 'Maria', '', 'Alex', '  ']),
			).toEqual(['Alex', 'Maria']);
		});
	});

	describe('createSpeakerProfile', () => {
		it('trims the name and starts with a unique id and no participants', () => {
			const a = createSpeakerProfile('  Weekly sync ');
			const b = createSpeakerProfile('Weekly sync');
			expect(a.name).toBe('Weekly sync');
			expect(a.participants).toEqual([]);
			expect(a.id).not.toBe(b.id);
		});
	});

	describe('addSpeakerProfile', () => {
		it('appends a named profile and ignores a blank name', () => {
			const added = addSpeakerProfile([], 'Standup');
			expect(added).toHaveLength(1);
			expect(added[0]?.name).toBe('Standup');
			expect(addSpeakerProfile(added, '   ')).toEqual(added);
		});
	});

	describe('participantsOf', () => {
		it("returns the named profile's participants", () => {
			const settings = mergeSettings({
				transcriptionSpeakerProfiles: [
					{ id: 'p1', name: 'Sync', participants: ['Alex', 'Maria'] },
				],
			});
			expect(participantsOf(settings, 'p1')).toEqual(['Alex', 'Maria']);
		});

		it('returns no suggestions for none or a removed profile', () => {
			const settings = mergeSettings({
				transcriptionSpeakerProfiles: [
					{ id: 'p1', name: 'Sync', participants: ['Alex'] },
				],
			});
			expect(participantsOf(settings, '')).toEqual([]);
			expect(participantsOf(settings, 'gone')).toEqual([]);
		});
	});

	describe('resolveRunParticipants', () => {
		const settings = mergeSettings({
			transcriptionSpeakerProfiles: [
				{ id: 'p1', name: 'Sync', participants: ['Alex', 'Maria'] },
			],
		});

		it('returns the selected profile participants', () => {
			SPEAKER_PROFILES.setSelectedId(settings, 'p1');
			expect(resolveRunParticipants(settings)).toEqual(['Alex', 'Maria']);
		});

		it('returns nothing for None or a stale selection', () => {
			SPEAKER_PROFILES.setSelectedId(settings, '');
			expect(resolveRunParticipants(settings)).toEqual([]);
			SPEAKER_PROFILES.setSelectedId(settings, 'gone');
			expect(resolveRunParticipants(settings)).toEqual([]);
		});
	});

	describe('addParticipantsToProfile', () => {
		const base: SpeakerProfile[] = [
			{ id: 'p1', name: 'Sync', participants: ['Alex'] },
			{ id: 'p2', name: 'Legal', participants: [] },
		];

		it('adds only new, trimmed names to the target profile', () => {
			const next = addParticipantsToProfile(base, 'p1', [
				' Maria ',
				'Alex',
				'',
			]);
			expect(next[0]?.participants).toEqual(['Alex', 'Maria']);
			expect(next[1]).toBe(base[1]);
		});

		it('returns an unchanged copy when nothing new is added', () => {
			const next = addParticipantsToProfile(base, 'p1', ['Alex']);
			expect(next).toEqual(base);
			expect(next).not.toBe(base);
		});

		it('returns an unchanged copy when the id is absent', () => {
			expect(addParticipantsToProfile(base, 'missing', ['X'])).toEqual(
				base,
			);
		});
	});
});
