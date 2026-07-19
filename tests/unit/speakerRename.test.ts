/**
 * Tests for the pure speaker-rename model: turning dialog entries into
 * display-level renames and rejecting a merge of two labels into one name.
 */

import {
	buildSpeakerRenames,
	duplicateAssignedNames,
	type SpeakerNameEntry,
} from 'src/speakers/speakerRename';

describe('speakerRename', () => {
	describe('buildSpeakerRenames', () => {
		it('keeps only entries with a non-empty name that differs from the label', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: ' Alex ' },
				{ label: 'Speaker 2', name: '' },
				{ label: 'Speaker 3', name: 'Speaker 3' },
			];
			expect(buildSpeakerRenames(entries)).toEqual([
				{ from: 'Speaker 1', to: 'Alex' },
			]);
		});

		it('supports swapping two names without chaining', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Alex', name: 'Bob' },
				{ label: 'Bob', name: 'Alex' },
			];
			expect(buildSpeakerRenames(entries)).toEqual([
				{ from: 'Alex', to: 'Bob' },
				{ from: 'Bob', to: 'Alex' },
			]);
		});
	});

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
	});
});
