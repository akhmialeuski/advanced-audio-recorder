/**
 * Public API of the recording domain for the UI layer. Modals and other
 * presentation code import from here instead of reaching into individual
 * recording modules, so the domain's internal layout can change without
 * touching the UI.
 * @module recording/api
 */

export { ConversionService } from './ConversionService';
export type { ConversionOutcome, ConversionRequest } from './ConversionService';
export { SplitService } from './SplitService';
export type { SplitOutcome, SplitRequest } from './SplitService';
export { clampSplitMinutes, sanitizePartSuffix } from './AudioSplitter';
export type { RecordingMarkerHandle } from './recordingMarkers';
export type { JournalSession } from './SessionJournal';
