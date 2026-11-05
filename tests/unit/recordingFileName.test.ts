import {
	renderRecordingFileName,
	templateProblem,
} from 'src/recording/recordingFileName';
import { DEFAULT_FILE_NAME_TEMPLATE } from 'src/constants';
import type { RecordingSessionConfig } from 'src/types';

const SESSION_ID = '2026-11-04T09-05-07-000Z';

/** 9:05:07 on 4 November 2026 in the machine's own time zone. */
const STARTED_AT = new Date(2026, 10, 4, 9, 5, 7).getTime();

/**
 * The part of a session the file name is rendered from.
 * @param fileName - The template and its values under test
 * @returns A session carrying them
 */
function sessionWith(
	fileName: Partial<RecordingSessionConfig['fileName']>,
): Pick<RecordingSessionConfig, 'sessionId' | 'fileName'> {
	return {
		sessionId: SESSION_ID,
		fileName: {
			template: DEFAULT_FILE_NAME_TEMPLATE,
			prefix: 'recording',
			noteName: 'Chorus idea',
			startedAt: STARTED_AT,
			...fileName,
		},
	};
}

describe('renderRecordingFileName', () => {
	it('reproduces the name every recording carried before templates', () => {
		const name = renderRecordingFileName(sessionWith({}), {
			source: 'Track1',
		});

		expect(name).toBe(`recording-Track1-${SESSION_ID}`);
	});

	it.each([
		{ prefix: 'v1.2 rec' },
		{ prefix: 'rec.' },
		{ prefix: 'Voice  note' },
	])(
		'keeps the prefix "$prefix" as typed in the default name',
		({ prefix }) => {
			const name = renderRecordingFileName(sessionWith({ prefix }), {
				source: 'Track1',
			});

			expect(name).toBe(`${prefix}-Track1-${SESSION_ID}`);
		},
	);

	it('folds a dot of the note name in, which would read as an extension boundary', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: '{{notename}}', noteName: 'v1.2 plan' }),
			{ source: 'Mic' },
		);

		expect(name).toBe('v1-2 plan');
	});

	it.each([
		{ template: '{{notename}}', expected: 'Chorus idea' },
		{ template: '{{ notename }}', expected: 'Chorus idea' },
		{ template: '{{prefix}}_{{track}}', expected: 'recording_2' },
		{ template: '{{source}}', expected: 'Mic' },
		{ template: '{{timestamp}}', expected: SESSION_ID },
	])('fills $template as $expected', ({ template, expected }) => {
		const name = renderRecordingFileName(sessionWith({ template }), {
			source: 'Mic',
			track: 2,
		});

		expect(name).toBe(expected);
	});

	it.each([
		{ template: '{{date}}', expected: '2026-11-04' },
		{ template: '{{time}}', expected: '09-05-07' },
		{ template: '{{date:YYYYMMDD}}', expected: '20261104' },
		{ template: '{{time:HH-mm}}', expected: '09-05' },
		{ template: '{{date:DD MMM YYYY}}', expected: '04 Nov 2026' },
	])('formats $template as $expected', ({ template, expected }) => {
		const name = renderRecordingFileName(sessionWith({ template }), {
			source: 'Mic',
		});

		expect(name).toBe(expected);
	});

	it('drops an empty variable and folds the dashes around it', () => {
		const name = renderRecordingFileName(
			sessionWith({
				template: '{{prefix}}-{{notename}}-{{timestamp}}',
				noteName: '',
			}),
			{ source: 'Mic' },
		);

		expect(name).toBe(`recording-${SESSION_ID}`);
	});

	it('leaves the track out of a file that is not one track', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: '{{source}}-{{track}}' }),
			{ source: 'multitrack' },
		);

		expect(name).toBe('multitrack');
	});

	it('replaces characters a vault path cannot carry', () => {
		const name = renderRecordingFileName(
			sessionWith({
				template: '{{notename}}',
				noteName: 'Q3: plan/draft?',
			}),
			{ source: 'Mic' },
		);

		expect(name).toBe('Q3- plan-draft');
	});

	it('names the file by its timestamp when nothing is left', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: '{{notename}}', noteName: '' }),
			{ source: 'Mic' },
		);

		expect(name).toBe(SESSION_ID);
	});

	it('keeps a name that is not a variable as typed', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: '{{prefix}}-{{unknown}}' }),
			{ source: 'Mic' },
		);

		expect(name).toBe('recording-{{unknown}}');
	});

	it('does not treat a property of Object as a variable', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: '{{constructor}}' }),
			{ source: 'Mic' },
		);

		expect(name).toBe('{{constructor}}');
	});
});

/** The most bytes a rendered base name may take, as the file name budget allows. */
const MAX_BASE_NAME_BYTES = 220;

/**
 * The size of a name on a file system that counts bytes.
 * @param text - A file name
 * @returns Its length in UTF-8 bytes
 */
function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

describe('a note name too long for a file name', () => {
	const NAMED = '{{notename}}-{{source}}-{{timestamp}}';

	it('is cut so the whole name stays within the byte budget', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: NAMED, noteName: 'Я'.repeat(200) }),
			{ source: 'Mic' },
		);

		expect(byteLength(name)).toBeLessThanOrEqual(MAX_BASE_NAME_BYTES);
	});

	it('keeps the source and the timestamp whole and uses the room left', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: NAMED, noteName: 'Я'.repeat(200) }),
			{ source: 'Mic' },
		);

		expect(name).toMatch(new RegExp(`^Я+-Mic-${SESSION_ID}$`));
		expect(byteLength(name)).toBeGreaterThanOrEqual(
			MAX_BASE_NAME_BYTES - 2,
		);
		expect(byteLength(name)).toBeLessThanOrEqual(MAX_BASE_NAME_BYTES);
	});

	it('leaves a name that fits untouched', () => {
		const noteName = 'Я'.repeat(50);

		const name = renderRecordingFileName(
			sessionWith({ template: NAMED, noteName }),
			{ source: 'Mic' },
		);

		expect(name).toBe(`${noteName}-Mic-${SESSION_ID}`);
	});

	it('is cut on a character boundary', () => {
		const name = renderRecordingFileName(
			sessionWith({ template: NAMED, noteName: '😀'.repeat(100) }),
			{ source: 'Mic' },
		);

		expect(name).toMatch(new RegExp(`^(?:😀)+-Mic-${SESSION_ID}$`));
	});

	it('is cut in every place the template uses it', () => {
		const name = renderRecordingFileName(
			sessionWith({
				template: '{{notename}} {{notename}}',
				noteName: 'Я'.repeat(200),
			}),
			{ source: 'Mic' },
		);

		expect(byteLength(name)).toBeLessThanOrEqual(MAX_BASE_NAME_BYTES);
	});

	it('gets less room when the rest of the name is long', () => {
		const prefix = 'p'.repeat(100);

		const name = renderRecordingFileName(
			sessionWith({
				template: `{{prefix}}-${NAMED}`,
				prefix,
				noteName: 'Я'.repeat(200),
			}),
			{ source: 'Mic' },
		);

		expect(name.startsWith(`${prefix}-Я`)).toBe(true);
		expect(byteLength(name)).toBeLessThanOrEqual(MAX_BASE_NAME_BYTES);
	});
});

describe('templateProblem', () => {
	it.each([
		DEFAULT_FILE_NAME_TEMPLATE,
		'{{notename}} {{date:YYYY-MM-DD}} {{time:HH-mm}}',
		'plain text without variables',
		'',
	])('accepts %j', (template) => {
		expect(templateProblem(template)).toBeUndefined();
	});

	it('names the unknown variable and the known ones', () => {
		expect(templateProblem('{{prefix}}-{{notname}}')).toBe(
			'Unknown variable {{notname}}. Known: prefix, notename, source, track, timestamp, date, time.',
		);
	});

	it.each(['{{Date}}', '{{note_name}}', '{{note-name}}', '{{notename2}}'])(
		'refuses the near miss %s',
		(template) => {
			expect(templateProblem(template)).toContain(
				`Unknown variable ${template}.`,
			);
		},
	);

	it('refuses a property of Object as an unknown variable', () => {
		expect(templateProblem('{{constructor}}')).toContain(
			'Unknown variable {{constructor}}',
		);
	});
});
