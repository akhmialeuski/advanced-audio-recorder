/**
 * Unit tests for the terms a run offers to its dictionary profile, and the
 * notice button that offers them.
 * @module tests/unit/termsOffer.test
 */

import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { termsOfferOf } from 'src/transcription/termsOffer';
import { notifyTranscriptWritten } from 'src/transcription/transcriptOutput';
import { el } from '../helpers/dom';
import { at } from '../helpers/assertions';
import { MODAL } from '../helpers/selectors';
import { noticeInstances, noticeMessages } from '../mocks/obsidian';

/**
 * Settings using a dictionary and a roster.
 * @param over - Settings over them
 */
function settingsOf(
	over: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	return mergeSettings({
		transcriptionAdvancedSettingsEnabled: true,
		profiles: [
			{ id: 'd', kind: 'dictionary', name: 'Platform', body: 'Helm' },
			{ id: 'p', kind: 'participants', name: 'Team', body: 'Anna Berg' },
		],
		selectedProfileIds: {
			...mergeSettings({}).selectedProfileIds,
			dictionary: 'd',
			participants: 'p',
		},
		...over,
	});
}

describe('termsOfferOf', () => {
	it('offers the terms the dictionary and the roster lack', () => {
		const offer = termsOfferOf(settingsOf(), [
			'helm',
			'Argo CD',
			'anna berg',
			'argo cd',
		]);

		expect(offer?.profile.id).toBe('d');
		expect(offer?.terms).toEqual(['Argo CD']);
	});

	it.each([
		['no term was collected', settingsOf(), []],
		['every term is known', settingsOf(), ['HELM', 'Anna Berg']],
		[
			'no dictionary is selected',
			settingsOf({
				selectedProfileIds: mergeSettings({}).selectedProfileIds,
			}),
			['Argo CD'],
		],
		[
			'the dictionary is not in use',
			settingsOf({ transcriptionAdvancedSettingsEnabled: false }),
			['Argo CD'],
		],
	])('offers nothing when %s', (_label, settings, terms) => {
		expect(termsOfferOf(settings, terms)).toBeNull();
	});
});

describe('the notice of a written transcript', () => {
	const written = {
		inserted: true,
		filePath: null,
		noteRequested: true,
		savedAsFallback: false,
		linkRequested: false,
		linkInserted: false,
	};

	it('carries the button of an action, which hides the notice and runs it', () => {
		const run = jest.fn();

		notifyTranscriptWritten(written, { label: 'Add terms', run });
		const notice = at(noticeInstances, 0);
		el(
			notice.initialMessage as DocumentFragment,
			MODAL.noticeAction,
		).click();

		expect(noticeMessages()).toEqual([
			'Transcript inserted into the note. Add terms',
		]);
		expect(run).toHaveBeenCalledTimes(1);
		expect(notice.hide).toHaveBeenCalledTimes(1);
	});

	it('is plain text without an action', () => {
		notifyTranscriptWritten(written, null);

		expect(at(noticeInstances, 0).initialMessage).toBe(
			'Transcript inserted into the note.',
		);
	});
});
