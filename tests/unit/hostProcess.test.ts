/**
 * Unit tests for the guarded read of Node's process object.
 * @module tests/unit/hostProcess.test
 */

import { hostProcess, hostSystemVersion } from 'src/platform/hostProcess';
import {
	useHostProcess,
	usePlatform,
	withoutProcess,
} from '../helpers/hostProcess';

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

describe('hostSystemVersion', () => {
	it('answers with the version the host reports', () => {
		useHostProcess({
			platform: 'darwin',
			getSystemVersion: () => '14.2.1',
		});

		expect(hostSystemVersion(hostProcess())).toBe('14.2.1');
	});

	// Node's own process has no such method; only Electron adds it.
	it.each([
		{ name: 'a process without the method', proc: { platform: 'linux' } },
		{
			name: 'an empty answer',
			proc: { platform: 'darwin', getSystemVersion: () => '' },
		},
		{
			// A native call that throws must not take a settings tab or a
			// diagnostics report down with it.
			name: 'a lookup that throws',
			proc: {
				platform: 'darwin',
				getSystemVersion: (): string => {
					throw new Error('not available');
				},
			},
		},
	])('answers undefined for $name', ({ proc }) => {
		useHostProcess(proc);

		expect(hostSystemVersion(hostProcess())).toBeUndefined();
	});

	it('answers undefined where the runtime declares no process', () => {
		withoutProcess();

		expect(hostSystemVersion(hostProcess())).toBeUndefined();
	});
});
