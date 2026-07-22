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
	MIN_CHAPTER_SECONDS,
	minChapterSecondsFor,
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

	it('appends the profile guidance before the language clause', () => {
		const prompt = buildChapterPrompt(LINES, {
			language: 'en',
			guidance: 'Split by agenda item.',
		});
		expect(prompt.system).toContain(
			'Additional guidance on how to divide this recording into chapters: ' +
				'Split by agenda item.',
		);
		// The fixed JSON contract still precedes any user guidance.
		expect(prompt.system.indexOf('JSON array')).toBeLessThan(
			prompt.system.indexOf('Additional guidance'),
		);
	});

	it('appends no guidance clause for blank guidance', () => {
		const prompt = buildChapterPrompt(LINES, { guidance: '   ' });
		expect(prompt.system).not.toContain('Additional guidance');
	});

	it('states the recording length so chapters span the whole timeline', () => {
		const prompt = buildChapterPrompt(LINES, { durationSeconds: 759 });
		// 759 seconds is 12:39; the model is told the real length and a
		// minimum chapter length so it does not bunch chapters at the start.
		expect(prompt.system).toContain('12:39');
		expect(prompt.system).toContain('759');
		expect(prompt.system).toContain('at least about 20 seconds');
	});

	it('omits the length clause when the duration is unknown', () => {
		const prompt = buildChapterPrompt(LINES);
		expect(prompt.system).not.toContain('The recording is');
	});
});

describe('minChapterSecondsFor', () => {
	it('uses the full minimum on a normal-length recording', () => {
		expect(minChapterSecondsFor(759)).toBe(MIN_CHAPTER_SECONDS);
	});

	it('relaxes the minimum for a short recording', () => {
		// A one-minute clip must not demand 20-second chapters.
		expect(minChapterSecondsFor(60)).toBe(10);
	});

	it('falls back to a tiny tolerance when the length is unknown', () => {
		expect(minChapterSecondsFor(null)).toBe(1);
		expect(minChapterSecondsFor(0)).toBe(1);
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

	it('snaps chapter starts onto the nearest real transcript line', () => {
		// The model returns times between lines; each snaps to the closest one.
		const output =
			'[{"time": 2, "title": "A"}, {"time": 118, "title": "B"}]';
		const lineTimes = [0, 60, 120, 300];
		expect(parseChapterResponse(output, 300, 1, lineTimes)).toEqual([
			{ time: 0, title: 'A' },
			{ time: 120, title: 'B' },
		]);
	});

	it('discards a chapter past the recording length instead of clamping it', () => {
		// 835s on a 759s recording is beyond the end; it must be dropped, not
		// clamped to a zero-length final chapter.
		const output =
			'[{"time": 0, "title": "A"}, {"time": 835, "title": "Past"}]';
		expect(
			parseChapterResponse(output, 759, 20).map(
				(chapter) => chapter.title,
			),
		).toEqual(['A']);
	});

	it('drops chapters bunched closer than the minimum gap', () => {
		// A model that crams chapters into the opening seconds must not yield
		// a run of one- and two-second chapters; the min gap keeps the first
		// of each cluster and drops the rest.
		const output =
			'[{"time": 0, "title": "A"}, {"time": 3, "title": "B"}, ' +
			'{"time": 5, "title": "C"}, {"time": 30, "title": "D"}, ' +
			'{"time": 31, "title": "E"}]';
		expect(parseChapterResponse(output, 759, 20)).toEqual([
			{ time: 0, title: 'A' },
			{ time: 30, title: 'D' },
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
