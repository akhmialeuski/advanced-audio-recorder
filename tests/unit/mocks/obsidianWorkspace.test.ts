/**
 * Contract tests for the workspace in the obsidian mock.
 *
 * Every file-action command the plugin registers is a checkCallback over
 * whatever file is open, so a workspace that cannot report one leaves all of
 * them permanently unavailable - and a test driving the palette would be
 * asserting against a command that never runs.
 * @module tests/unit/mocks/obsidianWorkspace.test
 */

// Imported from the mock by path: seedActiveFile and seedActiveView are the
// double's own contract, absent from the real type definitions.
import { Vault, Workspace } from '../../mocks/obsidian';
import { at } from '../../helpers/assertions';

describe('Workspace.getActiveFile', () => {
	it('reports nothing open until a file is seeded', () => {
		expect(new Workspace().getActiveFile()).toBeNull();
	});

	it('reports the file it was seeded with', () => {
		const workspace = new Workspace();
		const file = at(
			new Vault().seed([{ path: 'Audio/rec.wav', content: '' }]),
			0,
		);

		workspace.seedActiveFile(file);

		expect(workspace.getActiveFile()).toBe(file);
	});

	it('reports nothing open again once the file is cleared', () => {
		const workspace = new Workspace();
		workspace.seedActiveFile(
			at(new Vault().seed([{ path: 'Audio/rec.wav', content: '' }]), 0),
		);

		workspace.seedActiveFile(null);

		expect(workspace.getActiveFile()).toBeNull();
	});

	it('is a spy, so a test can assert it was consulted', () => {
		const workspace = new Workspace();

		workspace.getActiveFile();

		expect(workspace.getActiveFile).toHaveBeenCalled();
	});
});
