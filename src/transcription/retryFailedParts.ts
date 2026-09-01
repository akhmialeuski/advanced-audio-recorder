/**
 * Transcribes again only the parts a previous run could not, and splices what
 * comes back into the transcript that run already produced.
 *
 * The parts are known exactly: the plan that cuts a recording into parts is a
 * pure function of its duration and the engine's limit, so the same recording
 * prepares to the same boundaries every time, and the run recorded the bounds
 * of what it lost. That is what makes this a top-up rather than a second run:
 * exactly the missing stretches are sent, and exactly those are billed.
 *
 * The transcript is read back from the run's own JSON output, which is a
 * serialized transcript and therefore the one lossless source. A recording
 * whose outputs are only subtitles or plain text cannot be spliced into
 * without inventing the segment ends and speakers those formats drop, so the
 * retry says so instead of silently degrading the transcript it was asked to
 * complete.
 * @module transcription/retryFailedParts
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { serializeTranscriptFile } from './transcriptFormat';
import type { PartFailure, RecordingRange } from './partFailure';
import type { Transcript, TranscriptSegment } from './TranscriptTypes';
import type {
	TranscribeRunCost,
	TranscriptionSidecarAccess,
} from './TranscriptionService';
import type { FileOutput } from '../sidecar/recordingSidecarModel';

/** What the retry did, in the terms the user is told it in. */
export interface RetryOutcome {
	/** Segments the top-up placed on the timeline. */
	recovered: number;
	/**
	 * Parts still missing afterwards: the ones that failed again, and the
	 * ones this top-up had no bounds to ask for.
	 */
	stillMissing: PartFailure[];
	/** Transcript files rewritten with the completed transcript. */
	rewritten: number;
	/**
	 * Seconds of audio the top-up sent, which is what it was billed for and
	 * what sizes the estimate when the engine reports no usage.
	 */
	sentSeconds: number;
	/**
	 * What the engine reported for those stretches, so the caller puts the
	 * spend into the session total by the rule every surface follows. Absent
	 * when nothing was sent.
	 */
	cost?: TranscribeRunCost;
	/** Why nothing was attempted, when nothing was. */
	blocked?: string;
}

/** Reads and writes the records the retry works from. */
export interface RetrySidecar {
	/** The parts the last run could not transcribe. */
	getFailedParts(
		path: string,
	): Promise<{ parts: PartFailure[]; recordedAt: string } | null>;
	/** Records what still could not be transcribed. */
	setFailedParts(path: string, parts: readonly PartFailure[]): Promise<void>;
	/** The transcript files the last run wrote. */
	getTranscript(path: string): Promise<{ fileOutputs: FileOutput[] }>;
}

/** What one top-up run of the engine answers with. */
export interface RetryRun {
	/** The segments that came back for the stretches that were sent. */
	transcript: Transcript;
	/** The parts that failed again. */
	missingParts: PartFailure[];
	/** What the engine reported for the run, for the session total. */
	cost: TranscribeRunCost;
}

/** Runs the missing stretches again; the service, narrowed to what is used. */
export type RetryRunner = (
	file: TFile,
	ranges: readonly RecordingRange[],
) => Promise<RetryRun>;

/** The slice of the transcription service a top-up drives. */
export interface RetryTranscriber {
	run(
		file: TFile,
		options: {
			notePathForLinks: string;
			onlyRanges: readonly RecordingRange[];
			sidecar?: TranscriptionSidecarAccess | undefined;
			skipPostProcessing?: boolean | undefined;
		},
	): Promise<RetryRun>;
}

/**
 * Turns the transcription service into the runner a top-up calls. The link
 * path is the recording's own: a top-up reads the segments and never renders
 * the Markdown those links would appear in.
 *
 * The sidecar travels with the run so the recovered segments carry the speaker
 * names the user assigned, exactly as a full re-run does. Without it the
 * engine's own labels come back and splice into a transcript that has since
 * been renamed, leaving one document that says both "Alice" and "Speaker 1"
 * for the same person.
 * @param service - The transcription service
 * @param sidecar - The recording's sidecar, for speaker-name continuity
 * @returns The runner
 */
export function serviceRunner(
	service: RetryTranscriber,
	sidecar?: TranscriptionSidecarAccess,
): RetryRunner {
	return async (file, ranges) => {
		const result = await service.run(file, {
			notePathForLinks: file.path,
			onlyRanges: ranges,
			...(sidecar ? { sidecar } : {}),
			// The rendered document is discarded here, so paying an LLM to
			// clean up or translate a handful of recovered segments buys
			// nothing and bills the user for it.
			skipPostProcessing: true,
		});
		return {
			transcript: result.transcript,
			missingParts: result.missingParts,
			cost: result.cost,
		};
	};
}

/** A transcript with the retried stretches replaced, and by how much. */
export interface SplicedTranscript {
	/** The completed transcript, segments in time order. */
	transcript: Transcript;
	/** How many segments the top-up placed on the timeline. */
	spliced: number;
}

/**
 * Replaces the stretches a top-up asked for with what came back for them.
 *
 * Decided by the stretches rather than by comparing segment starts. The parts
 * a recording prepares to are a function of its duration and of the settings
 * in force, so a chunk size or an engine changed between the run and the
 * top-up moves the boundaries: parts that already succeeded are sent again,
 * come back at offsets a few tenths of a second from the ones stored, and a
 * proximity test then reads them as new segments and writes the same speech
 * into the transcript twice. A stretch cannot drift, because the stretch is
 * what the top-up asked for and was billed for, so what it holds afterwards
 * is exactly what came back for it - and anything the answer carried from
 * outside it is dropped rather than added beside what is already there.
 * @param existing - The transcript the earlier run produced
 * @param recovered - Segments the retry brought back
 * @param ranges - The stretches the retry asked for
 * @returns The completed transcript and how many segments it took
 */
export function spliceSegments(
	existing: Transcript,
	recovered: readonly TranscriptSegment[],
	ranges: readonly RecordingRange[],
): SplicedTranscript {
	const inside = (segment: TranscriptSegment): boolean =>
		ranges.some(
			(range) =>
				segment.start < range.endSeconds &&
				segment.end > range.startSeconds,
		);
	const taken = recovered.filter(inside);
	const merged = [
		...existing.segments.filter((segment) => !inside(segment)),
		...taken,
	];
	merged.sort((a, b) => a.start - b.start);
	return {
		transcript: { ...existing, segments: merged },
		spliced: taken.length,
	};
}

/**
 * Tops up a recording's transcript with the parts that failed.
 */
export class FailedPartRetry {
	/**
	 * @param app - Obsidian App, for reading and writing the outputs
	 * @param file - The recording to top up
	 * @param sidecar - Where the failed parts and the outputs are recorded
	 * @param run - Transcribes the given stretches of the recording
	 */
	constructor(
		private readonly app: App,
		private readonly file: TFile,
		private readonly sidecar: RetrySidecar,
		private readonly run: RetryRunner,
	) {}

	/**
	 * Sends the recorded failed parts again and writes the completed
	 * transcript back over the files the earlier run wrote.
	 * @returns What was recovered, what still is not, and what was rewritten
	 */
	async retry(): Promise<RetryOutcome> {
		const record = await this.sidecar.getFailedParts(this.file.path);
		const { ranges, unsent } = partitionParts(record?.parts ?? []);
		if (ranges.length === 0) {
			return this.blocked(
				record
					? 'The parts that failed carry no measured end, so they cannot be asked for on their own. Transcribe the recording again instead.'
					: 'Nothing is missing from this transcript.',
			);
		}
		const source = await this.readTranscript();
		if (!source) {
			return this.blocked(
				'Topping up needs the run to have written a JSON transcript, which is the only output that keeps the segment timings. Set the transcript file format to JSON and transcribe again.',
			);
		}
		const {
			transcript: recovered,
			missingParts,
			cost,
		} = await this.run(this.file, ranges);
		const completed = spliceSegments(
			source.transcript,
			recovered.segments,
			ranges,
		);
		// A part this top-up had no bounds for was never sent, so it is still
		// missing and stays on the record. Writing only what came back would
		// erase it, and an absent record means "nothing is missing".
		const stillMissing = [...unsent, ...missingParts];
		await this.sidecar.setFailedParts(this.file.path, stillMissing);
		return {
			recovered: completed.spliced,
			stillMissing,
			rewritten: await this.rewriteOutputs(
				completed.transcript,
				source.outputs,
			),
			sentSeconds: sentSeconds(ranges),
			cost,
		};
	}

	/**
	 * Reads the transcript back from the recorded JSON output.
	 * @returns The transcript and every output recorded for it, or null when
	 *   no readable JSON output was recorded
	 */
	private async readTranscript(): Promise<{
		transcript: Transcript;
		outputs: FileOutput[];
	} | null> {
		const section = await this.sidecar.getTranscript(this.file.path);
		// Only the recording's own transcript, never a translation: a
		// translation is a second document and topping it up would need the
		// translation pass, not the engine.
		const outputs = section.fileOutputs.filter((o) => !o.language);
		const json = outputs.find((output) => output.format === 'json');
		if (!json) {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(json.path);
		if (!(file instanceof TFile)) {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(await this.app.vault.read(file));
			return isTranscript(parsed)
				? { transcript: parsed, outputs }
				: null;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the transcript at ${json.path}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Writes the completed transcript over every file the earlier run wrote,
	 * each in the format it was written in. Rewritten rather than added to, so
	 * a top-up leaves the same outputs it found instead of a second set beside
	 * them. A file that has since been removed or cannot be written is counted
	 * out and warned about, never thrown.
	 * @param completed - The transcript with the recovered parts in it
	 * @param outputs - The files the earlier run recorded
	 * @returns How many were rewritten
	 */
	private async rewriteOutputs(
		completed: Transcript,
		outputs: readonly FileOutput[],
	): Promise<number> {
		let rewritten = 0;
		for (const output of outputs) {
			const file = this.app.vault.getAbstractFileByPath(output.path);
			if (!(file instanceof TFile)) {
				continue;
			}
			try {
				await this.app.vault.modify(
					file,
					serializeTranscriptFile(completed, output.format),
				);
				rewritten++;
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to rewrite ${output.path}:`,
					error,
				);
			}
		}
		return rewritten;
	}

	/**
	 * An outcome that attempted nothing, and why.
	 * @param reason - What to tell the user
	 * @returns The outcome
	 */
	private blocked(reason: string): RetryOutcome {
		return {
			recovered: 0,
			stillMissing: [],
			rewritten: 0,
			sentSeconds: 0,
			blocked: reason,
		};
	}
}

/**
 * Splits the recorded parts into the stretches a top-up can ask for and the
 * parts it cannot.
 *
 * A part carries a measured end only where the run cut the recording up; the
 * whole-file path has no smaller unit to send. Both halves are needed at the
 * end as well as the start, because a part that was never sent is still
 * missing and has to stay on the record beside whatever failed again.
 * @param parts - The recorded failed parts
 * @returns The stretches to transcribe again, and the parts left alone
 */
function partitionParts(parts: readonly PartFailure[]): {
	ranges: RecordingRange[];
	unsent: PartFailure[];
} {
	const ranges: RecordingRange[] = [];
	const unsent: PartFailure[] = [];
	for (const part of parts) {
		if (part.endSeconds === undefined) {
			unsent.push(part);
			continue;
		}
		ranges.push({
			startSeconds: part.startSeconds,
			endSeconds: part.endSeconds,
		});
	}
	return { ranges, unsent };
}

/**
 * How much audio a top-up sends, which is what it is billed for.
 * @param ranges - The stretches being transcribed again
 * @returns Their total length in seconds
 */
function sentSeconds(ranges: readonly RecordingRange[]): number {
	return ranges.reduce(
		(total, range) =>
			total + Math.max(0, range.endSeconds - range.startSeconds),
		0,
	);
}

/**
 * Whether a parsed value is a transcript this can splice into.
 * @param value - Parsed JSON from a recorded output
 * @returns True when it carries a segment list
 */
function isTranscript(value: unknown): value is Transcript {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return Array.isArray((value as { segments?: unknown }).segments);
}
