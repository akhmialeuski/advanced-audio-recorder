/**
 * Tests for the pure recording-marker helpers: position derivation,
 * file-index resolution, and the per-file fan-out used to persist markers
 * across plain, split, and multi-track recordings (and their mixes).
 * @module tests/unit/recordingMarkers.test
 */

import {
	computePartPosition,
	groupMarkersByFile,
	resolvePartFileIndex,
	type PartPositionState,
	type RecordingMarkerDraft,
} from 'src/recording/recordingMarkers';
import { MARKER_KIND } from 'src/markers/markerModel';
import type { TrackFileGroup } from 'src/types';

const state = (over: Partial<PartPositionState> = {}): PartPositionState => ({
	isWavPcm: false,
	splitEnabled: false,
	partMinutes: 15,
	partActiveMs: 0,
	sessionActiveMs: 0,
	sessionPartOrdinal: 0,
	...over,
});

const draft = (
	over: Partial<RecordingMarkerDraft> = {},
): RecordingMarkerDraft => ({
	id: 'd',
	partOrdinal: 0,
	offsetSeconds: 10,
	kind: MARKER_KIND.bookmark,
	label: 'Marker 1',
	...over,
});

describe('computePartPosition', () => {
	it('returns the whole-session offset when auto-split is off', () => {
		expect(
			computePartPosition(
				state({ splitEnabled: false, sessionActiveMs: 42000 }),
			),
		).toEqual({ partOrdinal: 0, offsetSeconds: 42 });
	});

	it('is zero at the very start of a recording', () => {
		expect(computePartPosition(state())).toEqual({
			partOrdinal: 0,
			offsetSeconds: 0,
		});
	});

	it('uses the rotation counter and per-part clock for a compressed split', () => {
		expect(
			computePartPosition(
				state({
					splitEnabled: true,
					partActiveMs: 12000,
					sessionActiveMs: 912000,
					sessionPartOrdinal: 2,
				}),
			),
		).toEqual({ partOrdinal: 2, offsetSeconds: 12 });
	});

	it('ignores the session clock for compressed split offsets', () => {
		// Compressed offset comes from the per-part clock, not the session
		// clock, so a large sessionActiveMs must not leak into the offset.
		expect(
			computePartPosition(
				state({
					splitEnabled: true,
					partActiveMs: 1000,
					sessionActiveMs: 9_999_000,
					sessionPartOrdinal: 5,
				}),
			),
		).toEqual({ partOrdinal: 5, offsetSeconds: 1 });
	});

	it('derives the PCM split ordinal at an exact part boundary', () => {
		expect(
			computePartPosition(
				state({
					isWavPcm: true,
					splitEnabled: true,
					partMinutes: 1,
					sessionActiveMs: 60000,
				}),
			),
		).toEqual({ partOrdinal: 1, offsetSeconds: 0 });
	});

	it('derives the PCM split ordinal and offset mid-part', () => {
		expect(
			computePartPosition(
				state({
					isWavPcm: true,
					splitEnabled: true,
					partMinutes: 1,
					sessionActiveMs: 90000,
				}),
			),
		).toEqual({ partOrdinal: 1, offsetSeconds: 30 });
	});

	it('keeps the first PCM part for times below one part length', () => {
		expect(
			computePartPosition(
				state({
					isWavPcm: true,
					splitEnabled: true,
					partMinutes: 1,
					sessionActiveMs: 30000,
				}),
			),
		).toEqual({ partOrdinal: 0, offsetSeconds: 30 });
	});

	it('computes a high PCM ordinal across many parts', () => {
		// 7.5 minutes at 1-minute parts => part 7, 30s in.
		expect(
			computePartPosition(
				state({
					isWavPcm: true,
					splitEnabled: true,
					partMinutes: 1,
					sessionActiveMs: 450000,
				}),
			),
		).toEqual({ partOrdinal: 7, offsetSeconds: 30 });
	});
});

describe('resolvePartFileIndex', () => {
	it('returns the ordinal when it is within range', () => {
		expect(resolvePartFileIndex(1, 3)).toBe(1);
	});

	it('returns the first file for ordinal 0', () => {
		expect(resolvePartFileIndex(0, 1)).toBe(0);
	});

	it('returns the last file for the residual ordinal', () => {
		expect(resolvePartFileIndex(2, 3)).toBe(2);
	});

	it('clamps to the last file when the ordinal overflows', () => {
		expect(resolvePartFileIndex(9, 3)).toBe(2);
	});

	it('clamps a negative ordinal to the first file', () => {
		expect(resolvePartFileIndex(-1, 3)).toBe(0);
	});

	it('returns -1 when the track produced no files', () => {
		expect(resolvePartFileIndex(0, 0)).toBe(-1);
	});
});

describe('groupMarkersByFile', () => {
	it('maps a single-file recording to that one file', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['rec.webm'] },
		];
		expect(
			groupMarkersByFile(
				[draft({ offsetSeconds: 12, label: 'M' })],
				groups,
			),
		).toEqual([
			{
				path: 'rec.webm',
				markers: [{ id: 'd', time: 12, label: 'M', kind: 'bookmark' }],
			},
		]);
	});

	it('fans one marker out to every track of a multi-track recording', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['mic.webm'] },
			{ trackIndex: 1, files: ['system.webm'] },
		];
		expect(
			groupMarkersByFile(
				[draft({ offsetSeconds: 8, label: 'Q' })],
				groups,
			),
		).toEqual([
			{
				path: 'mic.webm',
				markers: [{ id: 'd', time: 8, label: 'Q', kind: 'bookmark' }],
			},
			{
				path: 'system.webm',
				markers: [{ id: 'd', time: 8, label: 'Q', kind: 'bookmark' }],
			},
		]);
	});

	it('maps a merged multi-track recording to the single file at ordinal 0', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['merged.wav'] },
		];
		expect(
			groupMarkersByFile(
				[draft({ partOrdinal: 0, offsetSeconds: 5 })],
				groups,
			),
		).toEqual([
			{
				path: 'merged.wav',
				markers: [
					{ id: 'd', time: 5, label: 'Marker 1', kind: 'bookmark' },
				],
			},
		]);
	});

	it('routes split-recording markers to the part file of their ordinal', () => {
		const groups: TrackFileGroup[] = [
			{
				trackIndex: 0,
				files: ['rec-part1.wav', 'rec-part2.wav', 'rec.wav'],
			},
		];
		const writes = groupMarkersByFile(
			[
				draft({
					id: 'a',
					partOrdinal: 0,
					offsetSeconds: 4,
					label: 'A',
				}),
				draft({
					id: 'b',
					partOrdinal: 2,
					offsetSeconds: 6,
					label: 'B',
				}),
			],
			groups,
		);
		expect(writes).toEqual([
			{
				path: 'rec-part1.wav',
				markers: [{ id: 'a', time: 4, label: 'A', kind: 'bookmark' }],
			},
			{
				path: 'rec.wav',
				markers: [{ id: 'b', time: 6, label: 'B', kind: 'bookmark' }],
			},
		]);
	});

	it('handles a split + multi-track mix, fanning each part across tracks', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['mic-part1.wav', 'mic.wav'] },
			{ trackIndex: 1, files: ['sys-part1.wav', 'sys.wav'] },
		];
		const writes = groupMarkersByFile(
			[
				draft({
					id: 'a',
					partOrdinal: 0,
					offsetSeconds: 3,
					label: 'A',
				}),
				draft({
					id: 'b',
					partOrdinal: 1,
					offsetSeconds: 9,
					label: 'B',
				}),
			],
			groups,
		);
		expect(writes).toEqual([
			{
				path: 'mic-part1.wav',
				markers: [{ id: 'a', time: 3, label: 'A', kind: 'bookmark' }],
			},
			{
				path: 'mic.wav',
				markers: [{ id: 'b', time: 9, label: 'B', kind: 'bookmark' }],
			},
			{
				path: 'sys-part1.wav',
				markers: [{ id: 'a', time: 3, label: 'A', kind: 'bookmark' }],
			},
			{
				path: 'sys.wav',
				markers: [{ id: 'b', time: 9, label: 'B', kind: 'bookmark' }],
			},
		]);
	});

	it('clamps a marker whose part failed to save into the last file', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['part1.wav', 'residual.wav'] },
		];
		expect(
			groupMarkersByFile(
				[draft({ partOrdinal: 5, offsetSeconds: 7 })],
				groups,
			),
		).toEqual([
			{
				path: 'residual.wav',
				markers: [
					{ id: 'd', time: 7, label: 'Marker 1', kind: 'bookmark' },
				],
			},
		]);
	});

	it('skips a track that produced no files', () => {
		const groups: TrackFileGroup[] = [{ trackIndex: 0, files: [] }];
		expect(groupMarkersByFile([draft({})], groups)).toEqual([]);
	});

	it('returns nothing for an empty marker buffer', () => {
		const groups: TrackFileGroup[] = [
			{ trackIndex: 0, files: ['rec.webm'] },
		];
		expect(groupMarkersByFile([], groups)).toEqual([]);
	});

	it('returns nothing when there are no track groups', () => {
		expect(groupMarkersByFile([draft({})], [])).toEqual([]);
	});

	it('groups several markers into one file in insertion order', () => {
		const groups: TrackFileGroup[] = [{ trackIndex: 0, files: ['x.webm'] }];
		const writes = groupMarkersByFile(
			[
				draft({ id: 'a', offsetSeconds: 2, label: 'A' }),
				draft({
					id: 'b',
					offsetSeconds: 1,
					label: 'C1',
					kind: MARKER_KIND.chapter,
				}),
			],
			groups,
		);
		expect(writes).toEqual([
			{
				path: 'x.webm',
				markers: [
					{ id: 'a', time: 2, label: 'A', kind: 'bookmark' },
					{ id: 'b', time: 1, label: 'C1', kind: 'chapter' },
				],
			},
		]);
	});
});
