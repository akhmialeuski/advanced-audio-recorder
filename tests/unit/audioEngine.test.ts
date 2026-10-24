/**
 * Unit tests for the one accessor plugin code reaches the audio engine through.
 * @module tests/unit/audioEngine.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { encodingWorkerScript, loadAudioEngine } from 'src/audio/audioEngine';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import {
	installObjectUrlMock,
	type InstalledMock,
	type ObjectUrlDouble,
} from '../helpers/mediaMocks';

describe('loadAudioEngine', () => {
	it('hands every caller the same engine module', async () => {
		const [first, second] = await Promise.all([
			loadAudioEngine(),
			loadAudioEngine(),
		]);

		expect(second).toBe(first);
	});

	it('carries the encoder registrations, so they share the engine registry', async () => {
		const engine = await loadAudioEngine();

		expect(engine.registerFlacEncoder).toBe(registerFlacEncoder);
		expect(engine.registerMp3Encoder).toBe(registerMp3Encoder);
	});

	it('gives the worker no script when the build carries no engine', () => {
		expect(encodingWorkerScript('onmessage = run;')).toBeNull();
	});
});

describe('loadAudioEngine with the engine script the build carries', () => {
	const SCRIPT = 'var __aarAudioEngine = (() => ({}))();';
	const GLOBAL = '__aarAudioEngine';
	/** The first URL the object URL double hands out. */
	const BLOB_URL = 'blob:test/0';
	/** What the engine script declares, standing in for the engine. */
	const engineModule = { name: 'engine from the script' };
	const windowGlobals = window as unknown as Record<string, unknown>;

	let objectUrls: InstalledMock<ObjectUrlDouble>;

	beforeEach(() => {
		Object.assign(globalThis, {
			__AUDIO_ENGINE_SOURCE__: SCRIPT,
			__AUDIO_ENGINE_GLOBAL__: GLOBAL,
		});
		objectUrls = installObjectUrlMock();
	});

	afterEach(() => {
		objectUrls.restore();
		const globals = globalThis as Record<string, unknown>;
		delete globals.__AUDIO_ENGINE_SOURCE__;
		delete globals.__AUDIO_ENGINE_GLOBAL__;
		delete windowGlobals[GLOBAL];
	});

	/** A fresh copy of the accessor module, reading the globals set above. */
	function freshAccessor(): typeof import('src/audio/audioEngine') {
		let accessor: typeof import('src/audio/audioEngine') | undefined;
		jest.isolateModules(() => {
			accessor = jest.requireActual('src/audio/audioEngine');
		});
		if (!accessor) {
			throw new Error('the accessor module did not load');
		}
		return accessor;
	}

	/**
	 * The engine script element the accessor added. jsdom loads no script,
	 * so the test plays the browser: it declares the global and fires load.
	 */
	function engineScript(): HTMLScriptElement {
		const script = document.head.querySelector<HTMLScriptElement>(
			`script[src="${BLOB_URL}"]`,
		);
		if (!script) {
			throw new Error('no engine script element was added');
		}
		return script;
	}

	it('starts the worker from the engine script followed by its own code', () => {
		expect(freshAccessor().encodingWorkerScript('onmessage = run;')).toBe(
			`${SCRIPT}\nonmessage = run;`,
		);
	});

	it('gives the worker no script when the build injected no worker code', () => {
		expect(freshAccessor().encodingWorkerScript(null)).toBeNull();
	});

	it('runs the script from a Blob URL and reads the global it declares', async () => {
		const loading = freshAccessor().loadAudioEngine();
		const script = engineScript();
		windowGlobals[GLOBAL] = engineModule;
		script.dispatchEvent(new Event('load'));

		expect(await loading).toBe(engineModule);
		const created = jest.mocked(URL.createObjectURL).mock.calls;
		expect(created).toHaveLength(1);
		const [blob] = created[0] ?? [];
		if (!(blob instanceof Blob)) {
			throw new Error('the engine URL was not made from a Blob');
		}
		expect(blob.type).toBe('text/javascript');
		// jsdom's Blob has no text(); tests/setup.ts supplies arrayBuffer()
		const bytes = await blob.arrayBuffer();
		expect(new TextDecoder().decode(bytes)).toBe(SCRIPT);
		expect(objectUrls.instances[0]?.revoked).toEqual([BLOB_URL]);
		expect(script.isConnected).toBe(false);
	});

	it('loads the script once for callers that ask at the same time', async () => {
		const { loadAudioEngine: load } = freshAccessor();

		const both = Promise.all([load(), load()]);
		windowGlobals[GLOBAL] = engineModule;
		engineScript().dispatchEvent(new Event('load'));
		const [first, second] = await both;

		expect(second).toBe(first);
		expect(objectUrls.instances[0]?.created).toEqual([BLOB_URL]);
	});

	it('rejects, and releases the URL, when the script fails to load', async () => {
		const loading = freshAccessor().loadAudioEngine();
		const script = engineScript();
		script.dispatchEvent(new Event('error'));

		await expect(loading).rejects.toThrow(
			'The audio engine script failed to load',
		);
		expect(objectUrls.instances[0]?.revoked).toEqual([BLOB_URL]);
		expect(script.isConnected).toBe(false);
	});

	it('rejects when the script ran but declared no engine', async () => {
		const loading = freshAccessor().loadAudioEngine();
		engineScript().dispatchEvent(new Event('load'));

		await expect(loading).rejects.toThrow(
			`The audio engine script declared no ${GLOBAL}`,
		);
	});
});
