/**
 * Tests for the reporters a long job tells the user through: a notice, or a
 * notice and the answer of the command line that started the job.
 * @module tests/unit/notify.test
 */

import { collectingNotify, showNotice } from 'src/utils/notify';
import { noticeMessages } from '../mocks/obsidian';

describe('telling the user', () => {
	it('shows a notice', () => {
		showNotice('Converted.');

		expect(noticeMessages()).toEqual(['Converted.']);
	});

	it('keeps what it was told, in order, and still shows it', () => {
		const said = collectingNotify();

		said.notify('File exists.');
		said.notify('Kept the source.');

		expect(said.messages).toEqual(['File exists.', 'Kept the source.']);
		expect(noticeMessages()).toEqual(['File exists.', 'Kept the source.']);
	});
});
