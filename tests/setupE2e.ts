/**
 * The collaborator doubles every e2e suite runs against.
 *
 * All five e2e suites drive the plugin itself, so all five need the same four
 * collaborators recorded rather than reproduced - each of them has its own
 * suite already, and running the real thing here would test it twice while
 * pulling in a browser API jsdom does not have.
 *
 * `jest.mock` is hoisted per module, so the calls cannot live in a helper a
 * suite imports. A `setupFiles` entry is the framework's own answer: it runs
 * before the module registry is handed to the test file, so a mock registered
 * here applies to every suite in the project without any of them repeating it.
 * A suite that needs a different double still overrides it with its own
 * `jest.mock`, which wins over this one.
 * @module tests/setupE2e
 */

jest.mock('src/recording/RecordingManager', () =>
	require('./mocks/modules/recordingManager'),
);
jest.mock('src/ui/ContextMenu', () => require('./mocks/modules/contextMenu'));
jest.mock('src/player/EnhancedPlayerRegistrar', () =>
	require('./mocks/modules/enhancedPlayerRegistrar'),
);
jest.mock('src/recording/RecoveryService', () =>
	require('./mocks/modules/recoveryService'),
);
