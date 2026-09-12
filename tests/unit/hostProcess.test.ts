/**
 * Unit tests for the guarded read of Node's process object.
 * @module tests/unit/hostProcess.test
 */

import { hostProcess } from 'src/platform/hostProcess';
import { usePlatform, withoutProcess } from '../helpers/hostProcess';

describe('hostProcess', () => {
	it('answers with the process where the runtime declares one', () => {
		usePlatform('win32');

		expect(hostProcess()?.platform).toBe('win32');
	});

	// The whole reason this module exists. Obsidian mobile is a WebView that
	// declares no `process` at all, and an undeclared name throws on the way
	// to `?.` rather than answering undefined, so the read has to be guarded
	// by `typeof` and every caller has to come through here to get that.
	it('answers null where the runtime declares no process', () => {
		withoutProcess();

		expect(hostProcess()).toBeNull();
	});
});
