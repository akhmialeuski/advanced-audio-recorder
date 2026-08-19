/**
 * The context menu as the e2e suites see it: it records the services the
 * plugin built for its file actions, and registers nothing.
 * @module tests/mocks/modules/contextMenu
 */

export const ContextMenu = jest.fn(() => ({ register: jest.fn() }));
