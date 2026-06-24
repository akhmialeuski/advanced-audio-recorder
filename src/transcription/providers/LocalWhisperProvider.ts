/**
 * Transcription via a local whisper.cpp binary. Desktop only — it shells
 * out through Node's child_process, which is unavailable in the mobile
 * app. The service hands this provider a single decoded WAV per request (it
 * declares no upload limit), which is written to a temp file, transcribed to
 * JSON, then both temp files are removed.
 * @module transcription/providers/LocalWhisperProvider
 */

import {
	LOCAL_WHISPER_MAX_BUFFER_BYTES,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import type { TranscriptSegment } from '../TranscriptTypes';
import { LOCAL_WHISPER_CAPABILITIES } from './capabilities';
import type { WhisperResult } from './whisperResponse';
import { isRecord, num } from './responseUtils';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Minimal Node surface used by the local provider. */
interface NodeModules {
	childProcess: {
		execFile: (
			file: string,
			args: string[],
			options: { maxBuffer: number },
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
			`aar-whisper-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
		);
		const wavPath = `${base}.wav`;
		const jsonPath = `${base}.json`;
		node.fs.writeFileSync(wavPath, new Uint8Array(payload.data));

		const args = [
			'-m',
			this.config.modelPath,
			'-f',
			wavPath,
			'-oj',
			'-of',
			base,
			...(options.language ? ['-l', options.language] : []),
			...this.config.extraArgs,
		];

		try {
			await new Promise<void>((resolve, reject) => {
				node.childProcess.execFile(
					this.config.binaryPath,
					args,
					// whisper.cpp streams the full transcript to stdout; raise the
					// buffer so a long recording is not killed at Node's 1 MB default.
					{ maxBuffer: LOCAL_WHISPER_MAX_BUFFER_BYTES },
					(error) => {
						if (error) {
							reject(error);
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
			node.fs.rmSync(wavPath, { force: true });
			node.fs.rmSync(jsonPath, { force: true });
		}
	}
}
