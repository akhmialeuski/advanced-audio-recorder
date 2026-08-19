/**
 * The player registrar as the e2e suites see it: every method a spy.
 *
 * The registrar drives Obsidian's internal embed registry, which is covered by
 * its own suite; what the plugin owes it is the wiring, so here it only
 * records what it was asked to do.
 * @module tests/mocks/modules/enhancedPlayerRegistrar
 */

/** Every method the plugin calls on its player registrar, as a spy. */
export interface RegistrarDouble {
	register: jest.Mock;
	dispose: jest.Mock;
	refresh: jest.Mock;
	subscribePlayback: jest.Mock;
	reloadMarkersFor: jest.Mock;
	primeSavedRecordingsForEnhancement: jest.Mock;
}

export const EnhancedPlayerRegistrar = jest.fn(
	(): RegistrarDouble => ({
		register: jest.fn(),
		dispose: jest.fn(),
		refresh: jest.fn(),
		subscribePlayback: jest.fn(),
		reloadMarkersFor: jest.fn(),
		primeSavedRecordingsForEnhancement: jest.fn(),
	}),
);
