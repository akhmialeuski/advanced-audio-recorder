/**
 * Transcription via a local whisper.cpp binary. Desktop only - it shells
 * out through Node's child_process, which is unavailable in the mobile
 * app. The service hands this provider a single decoded WAV per request (it
 * declares no upload limit), which is written to a temp file, transcribed to
 * JSON, then both temp files are removed.
 *
 * The run is bounded the way a network request is, because it is the same kind
 * of thing: an external operation of unpredictable length. A limit on the
 * process is what a limit on a socket is elsewhere, and the run's cancel
 * reaches it the same way. Node's `execFile` takes both as options, so neither
 * needs a mechanism of its own.
 * @module transcription/providers/LocalWhisperProvider
 */

import {
	LOCAL_WHISPER_MAX_BUFFER_BYTES,
	PLUGIN_LOG_PREFIX,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import {
	DICTIONARY_JOIN_SEPARATOR,
	termsWithinWhisperPrompt,
} from '../dictionaryBias';
import type { TranscriptSegment } from '../TranscriptTypes';
import { LOCAL_WHISPER_CAPABILITIES } from './capabilities';
import type { WhisperResult } from './whisperResponse';
import { isRecord, num } from './responseUtils';
import { randomToken } from '../../utils/ids';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** How one child process is bounded and cancelled. */
interface ExecFileOptions {
	maxBuffer: number;
	/** Milliseconds after which Node kills the process. */
	timeout?: number;
	/** The run's cancel; aborting it kills the process. */
	signal?: AbortSignal;
}

/** Minimal Node surface used by the local provider. */
interface NodeModules {
	childProcess: {
		execFile: (
			file: string,
			args: string[],
			options: ExecFileOptions,
			callback: (
				error: Error | null,
				stdout: string,
				stderr: string,
			) => void,
		) => void;
	};
	fs: {
		writeFileSync: (path: string, data: Uint8Array) => void;
		readFileSync: (path: string, encoding: string) => string;
		rmSync: (path: string, options: { force: boolean }) => void;
	};
	os: { tmpdir: () => string };
	path: { join: (...parts: string[]) => string };
}

/** Configuration for the local whisper.cpp provider. */
export interface LocalWhisperConfig {
	binaryPath: string;
	modelPath: string;
	extraArgs: string[];
	/** Time limit for one run, in milliseconds, from the user's setting. */
	processTimeoutMs: number;
}

/**
 * Resolves Node builtins via Obsidian's desktop `require`, or null on
 * platforms (mobile) where they are unavailable.
 */
function loadNodeModules(): NodeModules | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		return {
			childProcess: req('child_process') as NodeModules['childProcess'],
			fs: req('fs') as NodeModules['fs'],
			os: req('os') as NodeModules['os'],
			path: req('path') as NodeModules['path'],
		};
	} catch {
		return null;
	}
}

/**
 * Maps whisper.cpp `-oj` JSON (offsets in milliseconds) to segments.
 * @param body - Parsed whisper.cpp JSON
 */
export function mapWhisperCppJson(body: unknown): WhisperResult {
	if (!isRecord(body)) {
		return { segments: [] };
	}
	const items = body.transcription;
	const language =
		typeof body.language === 'string' ? body.language : undefined;
	if (!Array.isArray(items)) {
		return { language, segments: [] };
	}
	const segments: TranscriptSegment[] = [];
	for (const entry of items) {
		if (!isRecord(entry)) {
			continue;
		}
		const offsets = isRecord(entry.offsets) ? entry.offsets : undefined;
		const text = typeof entry.text === 'string' ? entry.text.trim() : '';
		if (text === '') {
			continue;
		}
		const fromMs = offsets ? num(offsets.from) : 0;
		const toMs = offsets ? num(offsets.to, fromMs) : 0;
		segments.push({ start: fromMs / 1000, end: toMs / 1000, text });
	}
	return { language, segments };
}

/** Node's code for a child killed for outgrowing `maxBuffer`. */
const MAX_BUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Says which of the four ways a run can end badly this error is.
 *
 * Node reports a process it killed the same way it reports one that exited
 * with a status, so the error alone reads as "the binary failed" whether the
 * user pressed Cancel, the limit ran out, the output outgrew the buffer, or
 * the model path was wrong. Only the caller can tell them apart, because only
 * it holds the cancel and set the limit.
 *
 * The fourth is the binary's own to explain, and it does explain it: a model
 * it could not load or a flag it does not know is named on stderr, while the
 * error beside it says no more than that the exit was non-zero. Every ending
 * keeps the original as its `cause`, so the console still has what Node saw.
 * @param error - What execFile handed back
 * @param options - The run's options, holding its cancel
 * @param stderr - What the binary wrote to stderr, empty when it wrote nothing
 * @returns The error to reject with
 */
function describeRunFailure(
	error: Error,
	options: TranscribeOptions,
	stderr: string,
): Error {
	if (options.signal?.aborted) {
		return new Error('Local whisper.cpp run was cancelled.', {
			cause: error,
		});
	}
	const { killed, code } = error as { killed?: boolean; code?: string };
	// Ahead of the branch below, which reads the same `killed` marker: Node
	// sets it for a child it stopped for writing too much as well as for one
	// it stopped for running too long, and raising a time limit that was never
	// reached does nothing for the first.
	if (code === MAX_BUFFER_ERROR_CODE) {
		return new Error(
			'Local whisper.cpp produced more output than the plugin can read. ' +
				'Split the recording and transcribe it in parts.',
			{ cause: error },
		);
	}
	// Node's own marker for a process it killed, which here means the limit.
	if (killed) {
		return new Error(
			'Local whisper.cpp did not finish within the run timeout and was ' +
				'stopped. Raise Local run timeout in the settings, or use a ' +
				'smaller model.',
			{ cause: error },
		);
	}
	// Everything else is the binary's own failure, and the last line it wrote
	// is where it says which one. Node's message for it is "Command failed
	// with exit code 1", which sends a user with a mistyped model path looking
	// for a status code instead of the sentence naming the file.
	const detail = stderr.trim().split('\n').at(-1);
	if (!detail) {
		return error;
	}
	return new Error(`Local whisper.cpp failed: ${detail}`, { cause: error });
}

/**
 * Local whisper.cpp transcription provider (desktop only).
 */
export class LocalWhisperProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER;
	readonly label = 'Local whisper.cpp';
	readonly requiresNetwork = false;
	readonly capabilities: ProviderCapabilities = LOCAL_WHISPER_CAPABILITIES;
	private readonly node = loadNodeModules();

	constructor(private readonly config: LocalWhisperConfig) {}

	/** Whether the local binary path can be invoked on this platform. */
	isAvailable(): boolean {
		return this.node !== null;
	}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const node = this.node;
		if (!node) {
			throw new Error(
				'Local transcription is only available in the desktop app.',
			);
		}
		const base = node.path.join(
			node.os.tmpdir(),
			`aar-whisper-${String(Date.now())}-${randomToken()}`,
		);
		const wavPath = `${base}.wav`;
		const jsonPath = `${base}.json`;
		node.fs.writeFileSync(wavPath, new Uint8Array(payload.data));

		// The advanced second pass supplies a full bias sentence that already
		// folds the relevant terms in; it takes the --prompt slot over the plain
		// dictionary join. Otherwise, whisper.cpp shares Whisper's ~224-token
		// prompt window, so bound the dictionary the same way the service does
		// before building the flag.
		const biasPrompt = options.biasPrompt?.trim();
		const promptTerms =
			!biasPrompt && options.dictionary?.length
				? termsWithinWhisperPrompt(options.dictionary)
				: [];
		const promptValue =
			biasPrompt ??
			(promptTerms.length
				? promptTerms.join(DICTIONARY_JOIN_SEPARATOR)
				: undefined);
		const args = [
			'-m',
			this.config.modelPath,
			'-f',
			wavPath,
			'-oj',
			'-of',
			base,
			...(options.language ? ['-l', options.language] : []),
			// whisper.cpp seeds recognition from --prompt. Placed before extraArgs
			// so a user-supplied --prompt in extraArgs can still override it.
			...(promptValue ? ['--prompt', promptValue] : []),
			...this.config.extraArgs,
		];

		try {
			await new Promise<void>((resolve, reject) => {
				node.childProcess.execFile(
					this.config.binaryPath,
					args,
					{
						// whisper.cpp streams the full transcript to stdout;
						// raise the buffer so a long recording is not killed at
						// Node's 1 MB default.
						maxBuffer: LOCAL_WHISPER_MAX_BUFFER_BYTES,
						// Node kills the process on either of these, which is
						// what makes the dialog releasable. Without them a
						// binary that never returns left the promise pending
						// until Obsidian was restarted, and Cancel had nothing
						// to act on, because the run's token is only read
						// between parts and this engine has one.
						timeout: this.config.processTimeoutMs,
						...(options.signal ? { signal: options.signal } : {}),
					},
					(error, _stdout, stderr) => {
						if (error) {
							reject(describeRunFailure(error, options, stderr));
						} else {
							resolve();
						}
					},
				);
			});
			let raw: string;
			try {
				raw = node.fs.readFileSync(jsonPath, 'utf8');
			} catch {
				throw new Error(
					'Local whisper.cpp did not produce an output file. Check the binary and model paths.',
				);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				throw new Error(
					'Local whisper.cpp produced invalid JSON output.',
				);
			}
			return mapWhisperCppJson(parsed);
		} finally {
			for (const path of [wavPath, jsonPath]) {
				try {
					node.fs.rmSync(path, { force: true });
				} catch (error) {
					// `force` answers a file that is not there and nothing
					// else, and the run can now end while the binary is still
					// holding its input open: Node kills the child on the
					// cancel or the timeout, and Windows refuses to unlink a
					// file with a live handle. A throw from here would replace
					// the reason the run ended, so the user would be told
					// about a temp path instead of about their own Cancel.
					console.warn(
						`${PLUGIN_LOG_PREFIX} Temporary whisper.cpp file could not be removed:`,
						path,
						error,
					);
				}
			}
		}
	}
}
