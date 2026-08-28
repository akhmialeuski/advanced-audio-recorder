/**
 * Tests for the vault-wide search actions: that the one action defined is
 * always offered, because it is bound to no file and no playback, and that
 * running it opens the search rather than doing any searching itself.
 */

import { SEARCH_ACTIONS } from 'src/actions/searchActions';
import type { SearchServices } from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import { at } from '../helpers/assertions';

/** The one search action, with a services double to run it against. */
function createSut(): {
	action: (typeof SEARCH_ACTIONS)[number];
	services: SearchServices & { openMarkerSearch: jest.Mock };
} {
	const services = {
		openMarkerSearch: jest.fn().mockResolvedValue(undefined),
	};
	return { action: at(SEARCH_ACTIONS, 0), services };
}

describe('the vault-wide search actions', () => {
	it('defines the marker search under its own command id', () => {
		expect(SEARCH_ACTIONS.map((action) => action.commandId)).toEqual([
			COMMAND_IDS.searchMarkers,
		]);
	});

	it('is offered with nothing open, unlike a file or playback action', () => {
		const { action, services } = createSut();

		expect(action.isAvailable(services)).toBe(true);
	});

	it('opens the search rather than searching itself', async () => {
		const { action, services } = createSut();

		await action.run(services);

		expect(services.openMarkerSearch).toHaveBeenCalledTimes(1);
	});
});
