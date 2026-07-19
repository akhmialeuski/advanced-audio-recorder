/**
 * Tests for the participant-profile helpers used by the speaker rename dialog.
 */

import type { SpeakerProfile } from 'src/settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	createSpeakerProfile,
	findSpeakerProfile,
	normalizeParticipants,
	removeSpeakerProfile,
} from 'src/settings/speakerProfiles';

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

	describe('findSpeakerProfile / removeSpeakerProfile', () => {
		it('finds and removes by id', () => {
			const profiles = addSpeakerProfile([], 'Standup');
			const id = profiles[0]?.id ?? '';
			expect(findSpeakerProfile(profiles, id)?.name).toBe('Standup');
			expect(removeSpeakerProfile(profiles, id)).toEqual([]);
			expect(findSpeakerProfile(profiles, 'missing')).toBeUndefined();
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
