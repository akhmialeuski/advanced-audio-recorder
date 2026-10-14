/**
 * Tests for the vault-wide search actions: that each is always offered,
 * because it is bound to no file and no playback; that the palette opens the
 * search and the queue rather than doing anything itself; and that the
 * command line answers with what the search finds and what the queue holds,
 * driving the queue the way its dialog's buttons do.
 */

import {
	describeQueue,
	SEARCH_ACTIONS,
	searchActionFamily,
} from 'src/actions/searchActions';
import type {
	QueueStatusView,
	SearchServices,
	TranscriptionQueuePort,
} from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import type { MarkerHit } from 'src/markers/MarkerSearchIndex';
import { at } from '../helpers/assertions';

/** A marker as the index reports it. */
function hit(overrides: Partial<MarkerHit> = {}): MarkerHit {
	return {
		recordingPath: 'Recordings/standup.webm',
		recordingName: 'standup',
		id: 'm1',
		time: 75.6,
		label: 'Budget',
		kind: 'chapter',
		note: '',
		...overrides,
	};
}

/** A queue double over a fixed state, with every control a spy. */
function makeQueue(
	status: Partial<QueueStatusView> = {},
): TranscriptionQueuePort & {
	start: jest.Mock;
	pause: jest.Mock;
	clear: jest.Mock;
	remove: jest.Mock;
	open: jest.Mock;
} {
	return {
		queueFolder: jest.fn(),
		open: jest.fn(),
		enqueueFolder: jest.fn(),
		status: jest.fn().mockResolvedValue({
			entries: [],
			paused: false,
			running: false,
			...status,
		}),
		start: jest.fn(),
		pause: jest.fn(),
		clear: jest.fn(),
		remove: jest.fn().mockReturnValue(true),
	};
}

/** The search services, with the markers and the queue a test pins. */
function createSut(
	options: { hits?: MarkerHit[]; queue?: ReturnType<typeof makeQueue> } = {},
): {
	services: SearchServices & {
		openMarkerSearch: jest.Mock;
		openRecordingPanel: jest.Mock;
	};
	queue: ReturnType<typeof makeQueue>;
} {
	const queue = options.queue ?? makeQueue();
	return {
		services: {
			openMarkerSearch: jest.fn().mockResolvedValue(undefined),
			markerHits: jest.fn().mockResolvedValue(options.hits ?? [hit()]),
			transcriptionQueue: queue,
			openRecordingPanel: jest.fn().mockResolvedValue(undefined),
		},
		queue,
	};
}

/** Runs the marker search the way the command line runs it. */
function searchMarkers(
	services: SearchServices,
	args: Record<string, string> = {},
): Promise<string> {
	return Promise.resolve(at(SEARCH_ACTIONS, 0).cli.execute(services, args));
}

/** Runs the queue command the way the command line runs it. */
function queueCommand(
	services: SearchServices,
	args: Record<string, string> = {},
): Promise<string> {
	return Promise.resolve(at(SEARCH_ACTIONS, 1).cli.execute(services, args));
}

describe('the vault-wide actions', () => {
	it('defines each one under its own command id, in palette order', () => {
		expect(SEARCH_ACTIONS.map((action) => action.commandId)).toEqual([
			COMMAND_IDS.searchMarkers,
			COMMAND_IDS.openTranscriptionQueue,
			COMMAND_IDS.openRecordingPanel,
		]);
	});

	it('is offered with nothing open, unlike a file or playback action', () => {
		const { services } = createSut();

		expect(at(SEARCH_ACTIONS, 0).isAvailable(services)).toBe(true);
	});

	it('opens the search rather than searching itself', async () => {
		const { services } = createSut();

		await at(SEARCH_ACTIONS, 0).run(services);

		expect(services.openMarkerSearch).toHaveBeenCalledTimes(1);
	});

	it('targets the vault on every surface', async () => {
		const { services } = createSut();
		const family = searchActionFamily(services);

		expect(family.activeTargets()).toEqual([services]);
		await expect(
			Promise.resolve(family.cliTarget.resolve({})),
		).resolves.toEqual([services]);
		expect(family.describe(services)).toBe('the vault');
	});
});

describe('searching markers from the command line', () => {
	it('lists every marker with a link target to its time', async () => {
		const { services } = createSut();

		await expect(searchMarkers(services)).resolves.toBe(
			'Recordings/standup.webm#t=75\t1:15\tchapter\tBudget',
		);
	});

	it('adds the note a marker carries', async () => {
		const { services } = createSut({ hits: [hit({ note: 'Q3 numbers' })] });

		await expect(searchMarkers(services)).resolves.toBe(
			'Recordings/standup.webm#t=75\t1:15\tchapter\tBudget\tQ3 numbers',
		);
	});

	it.each([
		{ name: 'the label', query: 'budget' },
		{ name: 'the recording', query: 'standup' },
		{ name: 'the note', query: 'numbers' },
		{ name: 'several words of them', query: 'numbers budget' },
	])('finds a marker by $name', async ({ query }) => {
		const { services } = createSut({ hits: [hit({ note: 'Q3 numbers' })] });

		await expect(searchMarkers(services, { query })).resolves.toContain(
			'Budget',
		);
	});

	it('says so when nothing matches', async () => {
		const { services } = createSut();

		await expect(
			searchMarkers(services, { query: 'roadmap' }),
		).resolves.toBe('No markers match.');
	});

	it('keeps only the kind asked for', async () => {
		const { services } = createSut({
			hits: [
				hit(),
				hit({ id: 'm2', kind: 'bookmark', label: 'Question' }),
			],
		});

		await expect(
			searchMarkers(services, { kind: 'bookmark' }),
		).resolves.toBe(
			'Recordings/standup.webm#t=75\t1:15\tbookmark\tQuestion',
		);
	});

	it('stops at the limit', async () => {
		const { services } = createSut({
			hits: [hit(), hit({ id: 'm2', label: 'Second' })],
		});

		await expect(
			searchMarkers(services, { limit: '1' }),
		).resolves.not.toContain('Second');
	});

	it('answers with the markers as JSON', async () => {
		const marker = hit();
		const { services } = createSut({ hits: [marker] });

		await expect(
			searchMarkers(services, { format: 'json' }).then(JSON.parse),
		).resolves.toEqual([marker]);
	});

	it.each([
		{ param: 'kind', value: 'note', refusal: 'kind=note is not one of' },
		{
			param: 'limit',
			value: '0',
			refusal: 'limit=0 is not a whole number',
		},
		{ param: 'format', value: 'csv', refusal: 'format=csv is not one of' },
	])('refuses $param=$value', async ({ param, value, refusal }) => {
		const { services } = createSut();

		await expect(
			searchMarkers(services, { [param]: value }),
		).resolves.toContain(refusal);
	});
});

describe('showing the transcription queue', () => {
	it('is offered with nothing open, like the search beside it', () => {
		const { services } = createSut();

		expect(at(SEARCH_ACTIONS, 1).isAvailable(services)).toBe(true);
	});

	it('opens the queue rather than knowing what is in it', async () => {
		const { services, queue } = createSut();

		await at(SEARCH_ACTIONS, 1).run(services);

		expect(queue.open).toHaveBeenCalledTimes(1);
	});

	it('says an empty queue is empty', async () => {
		const { services } = createSut();

		await expect(queueCommand(services)).resolves.toBe(
			'The transcription queue is empty.',
		);
	});

	it.each([
		{ name: 'running', status: { running: true }, word: 'running' },
		{ name: 'paused', status: { paused: true }, word: 'paused' },
		{ name: 'idle', status: {}, word: 'not running' },
	])('reports a $name queue and its entries', ({ status, word }) => {
		expect(
			describeQueue({
				paused: false,
				running: false,
				...status,
				entries: [
					{ path: 'a.webm', state: 'waiting' },
					{ path: 'b.webm', state: 'failed', error: 'No key' },
				],
			}),
		).toBe(
			`The transcription queue is ${word}; 1 of 2 waiting.\nwaiting\ta.webm\nfailed\tb.webm\tNo key`,
		);
	});

	it.each([
		{ flag: 'start', control: 'start', said: 'Started.' },
		{ flag: 'pause', control: 'pause', said: 'Paused after' },
		{ flag: 'clear', control: 'clear', said: 'Cleared everything' },
	] as const)(
		'drives the queue with $flag',
		async ({ flag, control, said }) => {
			const { services, queue } = createSut();

			const answer = await queueCommand(services, { [flag]: 'true' });

			expect(queue[control]).toHaveBeenCalledTimes(1);
			expect(answer).toContain(said);
		},
	);

	it('removes the recording named', async () => {
		const { services, queue } = createSut();

		const answer = await queueCommand(services, { remove: 'a.webm' });

		expect(queue.remove).toHaveBeenCalledWith('a.webm');
		expect(answer).toContain('Removed a.webm.');
	});

	it('says why a recording was not removed', async () => {
		const queue = makeQueue();
		queue.remove.mockReturnValue(false);
		const { services } = createSut({ queue });

		await expect(
			queueCommand(services, { remove: 'a.webm' }),
		).resolves.toContain(
			'a.webm is not in the queue, or is being transcribed now.',
		);
	});
});

describe('opening the recording panel', () => {
	it('is offered with nothing open, since the panel explains what is', () => {
		const { services } = createSut();

		expect(at(SEARCH_ACTIONS, 2).isAvailable(services)).toBe(true);
	});

	it('asks the plugin to show the panel', async () => {
		const { services } = createSut();

		await at(SEARCH_ACTIONS, 2).run(services);

		expect(services.openRecordingPanel).toHaveBeenCalledTimes(1);
	});

	it('opens the panel from the command line and says so', async () => {
		const { services } = createSut();

		const answer = await at(SEARCH_ACTIONS, 2).cli.execute(services, {});

		expect(services.openRecordingPanel).toHaveBeenCalledTimes(1);
		expect(answer).toBe('Opened the recording panel in Obsidian.');
	});
});
