/**
 * The shipped plugin on the Electron builds Obsidian installers run on
 * (issue #164).
 *
 * Transcribing with the Whisper API failed at once on Electron 25 with
 * "Object not disposable". A recording over the 25 MB upload limit is decoded
 * first, and the decode releases its AudioContext through `await using`.
 * esbuild lowers that to a helper which looks the release up under
 * Symbol.asyncDispose, or under Symbol.for('Symbol.asyncDispose') where the
 * runtime has none, while the plugin stored it under whatever
 * Symbol.asyncDispose read when it ran: undefined, a property named
 * "undefined". The two never met. Electron 25 has neither symbol (Chromium
 * 114, Node.js 18.15); the audio engine adds Symbol.dispose when it first
 * loads, which is why the console showed one, and never Symbol.asyncDispose.
 *
 * A class keyed on Symbol.dispose had the same flaw at plugin load, before
 * the engine ever ran: StreamedSplit's release went under "undefined", where
 * nothing looks once the engine has added the symbol.
 *
 * Neither half exists under Jest, which is why the suite never saw it: ts-jest
 * lowers `using` differently from esbuild, and tests/setup.ts gives the
 * suite's realm both symbols. So these bundle the modules the way the release
 * does and run them in a realm set up like each runtime.
 * @module tests/integration/legacyDisposeRuntime.test
 */

import type * as StreamingSplit from 'src/audio/streamingSplit';
import type * as Constants from 'src/constants';
import type * as AudioPrep from 'src/transcription/audioPrep';
import type * as Capabilities from 'src/transcription/providers/capabilities';

import {
	bundleLikeRelease,
	createRealm,
	DisposeSymbols,
	evaluateBundle,
	loadEngineInto,
	type BundleFormat,
	type Realm,
} from '../helpers/releaseBundle';

/** The transcription step that failed, and a class keyed on Symbol.dispose. */
const ENTRY = `
export { audioContainerFromExtension, audioPrepOptions, prepareAudio } from './src/transcription/audioPrep';
export { WHISPER_API_CAPABILITIES } from './src/transcription/providers/capabilities';
export { WHISPER_API_MAX_REQUEST_BYTES } from './src/constants';
export { StreamedSplit } from './src/audio/streamingSplit';
`;

/** What the entry exports, as the bundle hands it back. */
type Shipped = Pick<
	typeof AudioPrep,
	'audioContainerFromExtension' | 'audioPrepOptions' | 'prepareAudio'
> &
	Pick<typeof Capabilities, 'WHISPER_API_CAPABILITIES'> &
	Pick<typeof Constants, 'WHISPER_API_MAX_REQUEST_BYTES'> &
	Pick<typeof StreamingSplit, 'StreamedSplit'>;

/** When the audio engine runs, relative to the plugin's own bundle. */
enum EngineLoad {
	/** Not yet: nothing has read a file's container since the plugin loaded. */
	NotYet = 'not yet',
	/** In a window, on first use, after the plugin loaded. */
	AfterPlugin = 'after the plugin',
	/** In the encoding worker, whose script starts with the engine. */
	BeforePlugin = 'before the plugin',
}

/** A runtime the plugin can land in, by what one realm of it offers. */
interface Runtime {
	runtime: string;
	symbols: DisposeSymbols;
	engine: EngineLoad;
	format: BundleFormat;
}

/** The Electron 25 window the report came from, once the engine has run. */
const ELECTRON_25_WINDOW: Runtime = {
	runtime: 'the window of Electron 25 once the audio engine has loaded',
	symbols: DisposeSymbols.Absent,
	engine: EngineLoad.AfterPlugin,
	format: 'cjs',
};

/** A window whose Chromium (134, Electron 35) or Node.js (18.18) has both. */
const MODERN_WINDOW: Runtime = {
	runtime: 'a window that has both symbols (Electron 35, or Node.js 18.18)',
	symbols: DisposeSymbols.Native,
	engine: EngineLoad.AfterPlugin,
	format: 'cjs',
};

/** The encoding worker below Electron 35: no Node.js, so neither symbol. */
const LEGACY_WORKER: Runtime = {
	runtime: 'a worker below Electron 35',
	symbols: DisposeSymbols.Absent,
	engine: EngineLoad.BeforePlugin,
	format: 'iife',
};

/** Every runtime the plugin's code can run in. */
const RUNTIMES: Runtime[] = [
	{
		runtime: 'the window of Electron 25 before the audio engine loads',
		symbols: DisposeSymbols.Absent,
		engine: EngineLoad.NotYet,
		format: 'cjs',
	},
	ELECTRON_25_WINDOW,
	LEGACY_WORKER,
	MODERN_WINDOW,
];

/** A desktop app, as the report's macOS one is. */
const OBSIDIAN = {
	Platform: {
		isDesktop: true,
		isDesktopApp: true,
		isMobile: false,
		isMobileApp: false,
	},
};

/** Length the stand-in decoder reports for every file, in seconds. */
const DECODED_SECONDS = 30;

/**
 * An AudioContext and an OfflineAudioContext for the realm, standing in for
 * the audio hardware: the decode answers a mono buffer of a fixed length, and
 * every close is recorded.
 * @param realm - The realm to install them in
 * @returns The record of closed contexts
 */
function installAudio(realm: Realm): jest.Mock {
	const closed = jest.fn();
	realm.context.AudioContext = class {
		state: AudioContextState = 'running';
		decodeAudioData(): Promise<object> {
			return Promise.resolve({
				duration: DECODED_SECONDS,
				sampleRate: 48_000,
				numberOfChannels: 1,
			});
		}
		close(): Promise<void> {
			this.state = 'closed';
			closed();
			return Promise.resolve();
		}
	};
	realm.context.OfflineAudioContext = class {
		readonly destination = {};
		constructor(
			_channels: number,
			private readonly frames: number,
		) {}
		createBufferSource(): object {
			return { connect: (): void => {}, start: (): void => {} };
		}
		startRendering(): Promise<object> {
			return Promise.resolve({
				getChannelData: () => new Float32Array(this.frames),
			});
		}
	};
	return closed;
}

/**
 * The plugin's modules running in a realm set up like the runtime, with the
 * audio engine loaded when that runtime would have loaded it.
 * @param runtime - The runtime to model
 * @returns The realm, the bundle's exports, and the record of closes
 */
function createSut(runtime: Runtime): {
	realm: Realm;
	shipped: Shipped;
	closed: jest.Mock;
} {
	const realm = createRealm(runtime.symbols, { obsidian: OBSIDIAN });
	const closed = installAudio(realm);
	if (runtime.engine === EngineLoad.BeforePlugin) {
		loadEngineInto(realm);
	}
	const shipped = evaluateBundle<Shipped>(
		realm,
		bundleLikeRelease(ENTRY, runtime.format),
		runtime.format,
	);
	if (runtime.engine === EngineLoad.AfterPlugin) {
		loadEngineInto(realm);
	}
	return { realm, shipped, closed };
}

/**
 * Prepares the upload of the report: a Whisper API run on an MP3 over the
 * engine's 25 MB request limit, which has to be decoded and split.
 * @param shipped - The bundled modules
 * @returns What the preparation resolves to
 */
function prepareOverLimitWhisperUpload(
	shipped: Shipped,
): ReturnType<Shipped['prepareAudio']> {
	return shipped.prepareAudio(
		new ArrayBuffer(shipped.WHISPER_API_MAX_REQUEST_BYTES + 1),
		'meeting.mp3',
		shipped.audioContainerFromExtension('mp3'),
		shipped.audioPrepOptions(
			shipped.WHISPER_API_CAPABILITIES,
			'Whisper API',
			true,
			shipped.WHISPER_API_MAX_REQUEST_BYTES,
			false,
		),
	);
}

describe('the shipped plugin on the Electron builds Obsidian runs on', () => {
	it.each(RUNTIMES)(
		'decodes an over-limit Whisper upload into WAV in $runtime',
		async (runtime) => {
			const { shipped } = createSut(runtime);

			const prepared = await prepareOverLimitWhisperUpload(shipped);

			expect(prepared.payloads.map((part) => part.contentType)).toEqual([
				'audio/wav',
			]);
		},
	);

	it.each(RUNTIMES)(
		'closes the AudioContext the decode ran in, in $runtime',
		async (runtime) => {
			const { shipped, closed } = createSut(runtime);

			await prepareOverLimitWhisperUpload(shipped);

			expect(closed).toHaveBeenCalledTimes(1);
		},
	);

	it.each([ELECTRON_25_WINDOW, MODERN_WINDOW, LEGACY_WORKER])(
		'keeps a streamed split releasable under Symbol.dispose in $runtime',
		(runtime) => {
			const { realm, shipped } = createSut(runtime);

			const release: unknown = Reflect.get(
				shipped.StreamedSplit.prototype,
				realm.run<symbol>('Symbol.dispose'),
			);

			expect(typeof release).toBe('function');
		},
	);

	it.each([
		{ name: 'Symbol.dispose', key: 'dispose' },
		{ name: 'Symbol.asyncDispose', key: 'asyncDispose' },
	])('leaves the $name a runtime already has as it was', ({ key }) => {
		const realm = createRealm(DisposeSymbols.Native, {
			obsidian: OBSIDIAN,
		});
		const before = realm.run<symbol>(`Symbol.${key}`);

		evaluateBundle(realm, bundleLikeRelease(ENTRY, 'cjs'), 'cjs');

		expect(realm.run<symbol>(`Symbol.${key}`)).toBe(before);
	});
});
