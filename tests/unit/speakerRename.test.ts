/**
 * Tests for the pure speaker-rename model: rejecting a merge of two labels
 * into one name.
 */

import {
	duplicateAssignedNames,
	type SpeakerNameEntry,
} from 'src/speakers/speakerRename';

describe('speakerRename', () => {
	describe('duplicateAssignedNames', () => {
		it('reports a name given to two distinct labels', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: ' Alex ' },
			];
			expect(duplicateAssignedNames(entries)).toEqual(['Alex']);
		});

		it('is empty when every assigned name is unique', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bob' },
				{ label: 'Speaker 3', name: '' },
			];
			expect(duplicateAssignedNames(entries)).toEqual([]);
		});

		it('detects a merge onto an existing label left blank', () => {
			// "Alex" is left blank (keeps the label "Alex"), while "Speaker 2"
			// is renamed to "Alex": applying would merge both into "Alex".
			const entries: SpeakerNameEntry[] = [
				{ label: 'Alex', name: '' },
				{ label: 'Speaker 2', name: 'Alex' },
			];
			expect(duplicateAssignedNames(entries)).toEqual(['Alex']);
		});

		it('is empty when all fields are left blank', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: '' },
				{ label: 'Speaker 2', name: '' },
			];
			expect(duplicateAssignedNames(entries)).toEqual([]);
		});
	});
});
