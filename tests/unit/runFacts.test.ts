/**
 * Unit tests for the facts of a run and the prompts they are filled into.
 * @module tests/unit/runFacts.test
 */

import { App, type CachedMetadata, type TFile } from 'obsidian';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	collectRunFacts,
	promptExpander,
	type RunFactsSource,
} from 'src/transcription/runFacts';
import { partial } from '../helpers/doubles';

const recording = partial<TFile>({
	name: 'standup.webm',
	basename: 'standup',
	path: 'Rec/standup.webm',
	stat: { ctime: 1000, mtime: 1000, size: 1 },
});

const note = partial<TFile>({
	basename: 'Weekly sync',
	path: 'Meetings/Weekly sync.md',
});

/**
 * A run source over an app whose note carries the given metadata.
 * @param cache - The note's metadata, or null for a note without any
 * @param overrides - Fields of the source to replace
 */
function createSut(
	cache: Partial<CachedMetadata> | null,
	overrides: Partial<RunFactsSource> = {},
): RunFactsSource {
	const app = new App();
	app.vault.getFileByPath = jest.fn((path: string) =>
		path === note.path ? note : null,
	);
	app.metadataCache.getFileCache = jest.fn(() => cache);
	app.fileManager.generateMarkdownLink = jest.fn(
		(file: TFile) => `[[${file.name}]]`,
	);
	return {
		app,
		settings: mergeSettings({}),
		recording,
		notePath: note.path,
		...overrides,
	};
}

describe('collectRunFacts', () => {
	it('reads the title, path and link from the note', () => {
		const facts = collectRunFacts(createSut(null), new Set());

		expect(facts).toEqual(
			expect.objectContaining({
				title: 'Weekly sync',
				notePath: 'Meetings/Weekly sync.md',
				recordingLink: '[[standup.webm]]',
				recordedAt: 1000,
			}),
		);
	});

	it('names the recording and leaves note facts empty without a note', () => {
		const facts = collectRunFacts(
			createSut(
				{ tags: [{ tag: '#x', position: partial({}) }] },
				{
					notePath: '',
				},
			),
			'all',
		);

		expect(facts).toEqual(
			expect.objectContaining({
				title: 'standup',
				notePath: '',
				tags: [],
				properties: {},
			}),
		);
	});

	it('collects the tags of the properties and the body once each', () => {
		const facts = collectRunFacts(
			createSut({
				frontmatter: { tags: ['meeting', '#atlas'] },
				tags: [
					{ tag: '#atlas', position: partial({}) },
					{ tag: '#q3', position: partial({}) },
				],
			}),
			new Set(),
		);

		expect(facts.tags).toEqual(['meeting', 'atlas', 'q3']);
	});

	it('splits tags written as one text property', () => {
		const facts = collectRunFacts(
			createSut({ frontmatter: { tags: 'a, b' } }),
			new Set(),
		);

		expect(facts.tags).toEqual(['a', 'b']);
	});

	it('reads only the properties named', () => {
		const facts = collectRunFacts(
			createSut({ frontmatter: { project: 'Atlas', salary: 1 } }),
			new Set(['project', 'missing']),
		);

		expect(facts.properties).toEqual({ project: 'Atlas' });
	});

	it('reads every property but the position when asked for all', () => {
		const facts = collectRunFacts(
			createSut({
				frontmatter: { project: 'Atlas', position: 'x' },
			}),
			'all',
		);

		expect(facts.properties).toEqual({ project: 'Atlas' });
	});

	it('takes the length, language and speakers from the transcript', () => {
		const facts = collectRunFacts(
			createSut(null, {
				transcript: {
					language: 'de',
					speakers: ['Anna'],
					segments: [{ start: 0, end: 42, text: 'x' }],
				},
				language: 'en',
			}),
			new Set(),
		);

		expect(facts).toEqual(
			expect.objectContaining({
				durationSeconds: 42,
				language: 'de',
				speakers: ['Anna'],
			}),
		);
	});

	it('takes the length and language from the caller without a transcript', () => {
		const facts = collectRunFacts(
			createSut(null, { durationSeconds: 90, language: 'en' }),
			new Set(),
		);

		expect(facts).toEqual(
			expect.objectContaining({
				durationSeconds: 90,
				language: 'en',
				speakers: [],
			}),
		);
	});

	it('leaves the length unknown when nobody knows it', () => {
		const facts = collectRunFacts(
			createSut(null, {
				transcript: { speakers: [], segments: [] },
			}),
			new Set(),
		);

		expect(facts).toEqual(
			expect.objectContaining({ durationSeconds: null, language: '' }),
		);
	});
});

describe('promptExpander', () => {
	it('returns a prompt without braces untouched', () => {
		const source = createSut(null);
		const expand = promptExpander(source);

		const text = expand('Plain prompt');

		expect(text).toBe('Plain prompt');
		expect(source.app.metadataCache.getFileCache).not.toHaveBeenCalled();
	});

	it('fills in the facts a prompt names', () => {
		const expand = promptExpander(
			createSut({ frontmatter: { project: 'Atlas' } }),
		);

		const text = expand('{{title}} / {{properties.project}}');

		expect(text).toBe('Weekly sync / Atlas');
	});
});
