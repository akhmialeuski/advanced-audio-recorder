/**
 * Tests for the pure auto-chapter logic: prompt construction from timed
 * transcript lines, tolerant parsing/validation of the LLM response, and
 * merging generated chapters into an existing marker list.
 */

import {
	AUTO_CHAPTER_ID_PREFIX,
	applyGeneratedChapters,
	buildChapterPrompt,
	isAutoChapterId,
	parseChapterResponse,
	type TimedLine,
} from 'src/chapters/chapterGeneration';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';

const LINES: TimedLine[] = [
	{ time: 0, text: 'Speaker 1: welcome everyone' },
	{ time: 65, text: 'Speaker 2: first topic' },
	{ time: 4000, text: 'Speaker 1: wrapping up' },
];

describe('buildChapterPrompt', () => {
	it('prefixes every line with a uniform-width timecode', () => {
		const prompt = buildChapterPrompt(LINES);
		// The last line is past an hour, so every timecode uses h:mm:ss.
		expect(prompt.user).toBe(
			'[0:00:00] Speaker 1: welcome everyone\n' +
				'[0:01:05] Speaker 2: first topic\n' +
				'[1:06:40] Speaker 1: wrapping up',
		);
	});

	it('asks for JSON chapters and appends the language clause', () => {
		const prompt = buildChapterPrompt(LINES, { language: 'ru' });
		expect(prompt.system).toContain('JSON array');
		expect(prompt.system).toContain(
			'The transcript language is ru; write the titles in that same language.',
		);
	});

	it('falls back to a same-language clause when the language is unknown', () => {
		const prompt = buildChapterPrompt(LINES);
		expect(prompt.system).toContain('same language as the transcript');
	});
});

describe('parseChapterResponse', () => {
	it('parses a plain JSON array', () => {
		const output =
			'[{"time": 0, "title": "Intro"}, {"time": 65, "title": "Topic"}]';
		expect(parseChapterResponse(output, 4000)).toEqual([
			{ time: 0, title: 'Intro' },
			{ time: 65, title: 'Topic' },
		]);
	});

	it('tolerates code fences and surrounding prose', () => {
		const output =
			'Here are the chapters:\n```json\n[{"time": 10, "title": "A"}]\n```\nDone.';
		expect(parseChapterResponse(output, 100)).toEqual([
			{ time: 10, title: 'A' },
		]);
	});

	it('accepts timecode strings as times', () => {
		const output =
			'[{"time": "1:05", "title": "A"}, {"time": "0:00:30", "title": "B"}]';
		expect(parseChapterResponse(output, 4000)).toEqual([
			{ time: 30, title: 'B' },
			{ time: 65, title: 'A' },
		]);
	});

	it('drops invalid entries and empty titles', () => {
		const output =
			'[{"time": 5, "title": "OK"}, {"title": "no time"}, ' +
			'{"time": 9, "title": "  "}, "not an object", {"time": "x", "title": "bad"}]';
		expect(parseChapterResponse(output, 100)).toEqual([
			{ time: 5, title: 'OK' },
		]);
	});

	it('clamps negatives to zero and slight overshoots to the max time', () => {
		const output =
			'[{"time": -3, "title": "Start"}, {"time": 100.5, "title": "End"}]';
		expect(parseChapterResponse(output, 100)).toEqual([
			{ time: 0, title: 'Start' },
			{ time: 100, title: 'End' },
		]);
	});

	it('discards chapters far past the known end of the transcript', () => {
		const output =
			'[{"time": 10, "title": "A"}, {"time": 500, "title": "Invented"}]';
		expect(parseChapterResponse(output, 100)).toEqual([
			{ time: 10, title: 'A' },
		]);
	});

	it('sorts by time and collapses near-duplicate boundaries', () => {
		const output =
			'[{"time": 60, "title": "B"}, {"time": 0, "title": "A"}, ' +
			'{"time": 60.5, "title": "B again"}]';
		expect(parseChapterResponse(output, 100)).toEqual([
			{ time: 0, title: 'A' },
			{ time: 60, title: 'B' },
		]);
	});

	it('returns an empty list for unparseable output', () => {
		expect(parseChapterResponse('no chapters here', 100)).toEqual([]);
		expect(parseChapterResponse('[not json]', 100)).toEqual([]);
		expect(parseChapterResponse('{"time": 1}', 100)).toEqual([]);
	});

	it('truncates overlong titles', () => {
		const output = `[{"time": 1, "title": "${'x'.repeat(300)}"}]`;
		const parsed = parseChapterResponse(output, 100);
		expect(parsed[0]?.title).toHaveLength(120);
	});
});

describe('applyGeneratedChapters', () => {
	const makeId = (): (() => string) => {
		let n = 0;
		return () => `id${String(++n)}`;
	};

	const manualChapter: PlayerMarker = {
		id: 'manual-1',
		time: 120,
		label: 'My chapter',
		kind: MARKER_KIND.chapter,
	};
	const bookmark: PlayerMarker = {
		id: 'bm-1',
		time: 30,
		label: 'Bookmark',
		kind: MARKER_KIND.bookmark,
	};
	const oldAuto: PlayerMarker = {
		id: `${AUTO_CHAPTER_ID_PREFIX}old`,
		time: 200,
		label: 'Old auto',
		kind: MARKER_KIND.chapter,
	};

	it('replaces previous auto chapters, keeping bookmarks and manual chapters', () => {
		const merged = applyGeneratedChapters(
			[bookmark, manualChapter, oldAuto],
			[{ time: 10, title: 'Intro' }],
			makeId(),
		);
		expect(merged.map((m) => m.label)).toEqual([
			'Intro',
			'Bookmark',
			'My chapter',
		]);
		expect(merged[0]?.id).toBe(`${AUTO_CHAPTER_ID_PREFIX}id1`);
		expect(merged[0]?.kind).toBe(MARKER_KIND.chapter);
	});

	it('skips a generated chapter colliding with a manual chapter', () => {
		const merged = applyGeneratedChapters(
			[manualChapter],
			[
				{ time: 120.4, title: 'Duplicate' },
				{ time: 300, title: 'Later' },
			],
			makeId(),
		);
		expect(merged.map((m) => m.label)).toEqual(['My chapter', 'Later']);
	});

	it('keeps the result sorted by time', () => {
		const merged = applyGeneratedChapters(
			[bookmark],
			[
				{ time: 300, title: 'C' },
				{ time: 5, title: 'A' },
			],
			makeId(),
		);
		expect(merged.map((m) => m.time)).toEqual([5, 30, 300]);
	});
});

describe('isAutoChapterId', () => {
	it('recognizes only prefixed ids', () => {
		expect(isAutoChapterId(`${AUTO_CHAPTER_ID_PREFIX}abc`)).toBe(true);
		expect(isAutoChapterId('manual')).toBe(false);
	});
});
