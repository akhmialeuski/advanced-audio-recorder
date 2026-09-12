/**
 * Unit tests for the guarded read of Node's process object.
 * @module tests/unit/hostProcess.test
 */

import { hostProcess } from 'src/platform/hostProcess';
import { usePlatform, withoutProcess } from '../helpers/displayMediaHost';

describe('hostProcess', () => {
	let restore: (() => void)[] = [];

	afterEach(() => {
		restore.forEach((undo) => {
			undo();
		});
		restore = [];
	});

	it('answers with the process where the runtime declares one', () => {
		restore.push(usePlatform('win32'));

		expect(hostProcess()?.platform).toBe('win32');
	});

	// The whole reason this module exists. Obsidian mobile is a WebView that
	// declares no `process` at all, and an undeclared name throws on the way
	// to `?.` rather than answering undefined, so the read has to be guarded
	// by `typeof` and every caller has to come through here to get that.
	it('answers null where the runtime declares no process', () => {
		restore.push(withoutProcess());

		expect(hostProcess()).toBeNull();
	});
});
