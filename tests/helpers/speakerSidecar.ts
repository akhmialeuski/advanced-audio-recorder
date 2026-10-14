/**
 * The slice of a recording's sidecar a speaker rename reads and writes,
 * holding one roster, every write a spy. The rename dialog and the command
 * line drive the same rename over it.
 * @module tests/helpers/speakerSidecar
 */

import type { TranscriptSection } from 'src/sidecar/recordingSidecarModel';

/** The rename's sidecar, each method a spy. */
export interface SpeakerSidecarDouble {
	getTranscript: jest.Mock;
	isSidecarCorrupt: jest.Mock;
	commitRename: jest.Mock;
	setSpeakers: jest.Mock;
	popHistory: jest.Mock;
}

/**
 * A sidecar whose transcript section is the given roster.
 * @param section - The stored roster
 * @param corrupt - Whether the sidecar file exists but could not be read
 */
export function speakerSidecar(
	section: TranscriptSection,
	corrupt = false,
): SpeakerSidecarDouble {
	return {
		getTranscript: jest.fn().mockResolvedValue(section),
		isSidecarCorrupt: jest.fn().mockReturnValue(corrupt),
		commitRename: jest.fn().mockResolvedValue(undefined),
		setSpeakers: jest.fn().mockResolvedValue(undefined),
		popHistory: jest.fn().mockResolvedValue(undefined),
	};
}
