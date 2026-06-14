/**
 * Transcription via a local whisper.cpp binary. Desktop only — it shells
 * out through Node's child_process, which is unavailable in the mobile
 * app. Each chunk is written to a temp WAV, transcribed to JSON, then the
 * temp files are removed.
 * @module transcription/providers/LocalWhisperProvider
 */

import type { TranscriptSegment } from '../TranscriptTypes';
import type { WhisperResult } from './whisperResponse';
import type {
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Minimal Node surface used by the local provider. */
interface NodeModules {
	childProcess: {
		execFile: (
			file: string,
			args: string[],
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
	if (typeof body !== 'object' || body === null) {
		return { segments: [] };
	}
	const record = body as Record<string, unknown>;
	const items = record.transcription;
	const language =
		typeof record.language === 'string' ? record.language : undefined;
	if (!Array.isArray(items)) {
		return { language, segments: [] };
	}
	const segments: TranscriptSegment[] = [];
	for (const entry of items) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const item = entry as Record<string, unknown>;
		const offsets = item.offsets as Record<string, unknown> | undefined;
		const text = typeof item.text === 'string' ? item.text.trim() : '';
		if (text === '') {
			continue;
		}
		const fromMs =
			offsets && typeof offsets.from === 'number' ? offsets.from : 0;
		const toMs = offsets && typeof offsets.to === 'number' ? offsets.to : 0;
		segments.push({ start: fromMs / 1000, end: toMs / 1000, text });
	}
	return { language, segments };
}

/**
 * Local whisper.cpp transcription provider (desktop only).
 */
export class LocalWhisperProvider implements TranscriptionProvider {
	readonly id = 'local-whisper';
	readonly label = 'Local whisper.cpp';
	readonly requiresNetwork = false;
	private readonly node = loadNodeModules();

	constructor(private readonly config: LocalWhisperConfig) {}

	/** Whether the local binary path can be invoked on this platform. */
	isAvailable(): boolean {
		return this.node !== null;
	}

	async transcribe(
		audio: ArrayBuffer,
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
		node.fs.writeFileSync(wavPath, new Uint8Array(audio));

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
					(error) => {
						if (error) {
							reject(error);
						} else {
							resolve();
						}
					},
				);
			});
			const raw = node.fs.readFileSync(jsonPath, 'utf8');
			return mapWhisperCppJson(JSON.parse(raw));
		} finally {
			node.fs.rmSync(wavPath, { force: true });
			node.fs.rmSync(jsonPath, { force: true });
		}
	}
}
