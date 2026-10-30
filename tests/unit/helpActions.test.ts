/**
 * Tests for the actions that explain the plugin: the palette opens the
 * release notes, the command line prints them, all or only the newer ones.
 * @module tests/unit/helpActions.test
 */

import { HELP_ACTIONS, helpActionFamily } from 'src/actions/help/helpActions';
import { releaseNotesSince } from 'src/release/releaseNotes';
import type { HelpServices } from 'src/actions/core/PluginAction';
import { at } from '../helpers/assertions';

/** The help services, the dialog a spy. */
function createSut(): HelpServices & { showReleaseNotes: jest.Mock } {
	return { showReleaseNotes: jest.fn() };
}

const whatsNew = at(HELP_ACTIONS, 0);

describe("what's new", () => {
	it('opens the notes in the palette', () => {
		const services = createSut();

		void whatsNew.run(services);

		expect(services.showReleaseNotes).toHaveBeenCalledTimes(1);
	});

	it('prints every release the bundle carries notes for', () => {
		expect(whatsNew.cli.execute(createSut(), {})).toBe(
			releaseNotesSince(''),
		);
	});

	it('prints only the releases after the one named', () => {
		const answer = whatsNew.cli.execute(createSut(), { since: '2.0.0' });

		expect(answer).toBe(releaseNotesSince('2.0.0'));
		expect(answer).not.toContain('# 2.0.0\n');
	});

	it('says so when nothing came after the one named', () => {
		expect(whatsNew.cli.execute(createSut(), { since: '999.0.0' })).toBe(
			'No release notes after 999.0.0.',
		);
	});

	it('is bound to nothing, so always offered', async () => {
		const services = createSut();
		const family = helpActionFamily(services);

		expect(family.activeTargets()).toEqual([services]);
		await expect(
			Promise.resolve(family.cliTarget.resolve({})),
		).resolves.toEqual({ value: [services] });
		expect(family.describe(services)).toBe('the plugin');
		expect(whatsNew.isAvailable(services)).toBe(true);
	});
});
