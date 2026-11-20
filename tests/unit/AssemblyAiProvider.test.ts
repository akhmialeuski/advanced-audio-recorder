/**
 * Tests for the AssemblyAiProvider job: the upload that hands the payload over
 * as it was lent, the request that queues a transcript for it, the wait for
 * the job to complete, and the sentences read back as segments. The endpoint
 * answers each step separately, so every case scripts the answers in the order
 * the steps ask for them.
 */

import { AssemblyAiProvider } from 'src/transcription/providers/AssemblyAiProvider';
import { ASSEMBLYAI_POLL_INTERVAL_MS } from 'src/constants';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import type { MockRequestUrlResponse } from '../mocks/obsidian';
import { queueResponses, withRequestUrl } from '../helpers/network';
import { at, jsonBody } from '../helpers/assertions';
import { outcomeOf, settleAcross } from '../helpers/async';
import { transcribeOptions } from '../helpers/providerFixtures';

const BASE_URL = 'https://assembly.example';
const MODEL = 'assemblyai-stt-3-7';
const UPLOAD_URL = 'https://cdn.assembly.example/upload/abc';

/** The body that queues a transcript, as the provider serializes it. */
interface JobRequest {
	audio_url: string;
	speech_models: string[];
	speaker_labels: boolean;
	language_code?: string;
	language_detection?: boolean;
	keyterms_prompt?: string[];
}

/** A recording as a vault file hands it over. */
const PAYLOAD: AudioPayload = {
	data: new Uint8Array([1, 2, 3, 4]).buffer,
	contentType: 'audio/webm',
	filename: 'rec.webm',
	offsetSeconds: 0,
};

/**
 * One JSON answer of the endpoint.
 * @param body - What the step answers with
 * @returns The response the request mock returns
 */
const answer = (body: unknown): Partial<MockRequestUrlResponse> => ({
	text: JSON.stringify(body),
});

const UPLOADED = answer({ upload_url: UPLOAD_URL });
const QUEUED = answer({ id: 'job-1', status: 'queued' });
const PROCESSING = answer({ id: 'job-1', status: 'processing' });
const COMPLETED = answer({
	id: 'job-1',
	status: 'completed',
	text: 'Hello there.',
	language_code: 'en',
	audio_duration: 12,
});
const SENTENCES = answer({
	sentences: [
		{
			text: 'Hello there.',
			start: 500,
			end: 1500,
			speaker: 'A',
			words: [
				{ text: 'Hello', start: 500, end: 900 },
				{ text: 'there.', start: 950, end: 1500 },
			],
		},
	],
});

/** A temporary refusal, which the service answers by sending a part again. */
const UNAVAILABLE: Partial<MockRequestUrlResponse> = {
	status: 503,
	text: 'Service unavailable',
};

/** A job that completes on the first read of its status. */
const WHOLE_JOB = [UPLOADED, QUEUED, COMPLETED, SENTENCES];

/**
 * The provider under test.
 * @param config - What this case varies about the configuration
 * @returns A provider pointed at the scripted endpoint
 */
const provider = (
	config: Partial<ConstructorParameters<typeof AssemblyAiProvider>[0]> = {},
): AssemblyAiProvider =>
	new AssemblyAiProvider({
		baseUrl: BASE_URL,
		apiKey: 'aai-key',
		model: MODEL,
		...config,
	});

describe('AssemblyAiProvider', () => {
	it('uploads the recording, queues a job, and reads its sentences', async () => {
		const sent = queueResponses(WHOLE_JOB);

		const result = await provider().transcribe(
			PAYLOAD,
			transcribeOptions(),
		);

		expect(sent.map((request) => [request.method, request.url])).toEqual([
			['POST', `${BASE_URL}/v2/upload`],
			['POST', `${BASE_URL}/v2/transcript`],
			['GET', `${BASE_URL}/v2/transcript/job-1`],
			['GET', `${BASE_URL}/v2/transcript/job-1/sentences`],
		]);
		// The bytes go up as they were lent, and the key travels bare
		const upload = at(sent, 0);
		expect(upload.body).toBe(PAYLOAD.data);
		expect(upload.contentType).toBe('application/octet-stream');
		for (const request of sent) {
			expect(request.headers).toEqual({ Authorization: 'aai-key' });
		}
		expect(jsonBody<JobRequest>(at(sent, 1))).toEqual({
			audio_url: UPLOAD_URL,
			speech_models: [MODEL],
			speaker_labels: false,
			language_detection: true,
		});
		expect(result).toEqual({
			language: 'en',
			segments: [
				{
					start: 0.5,
					end: 1.5,
					text: 'Hello there.',
					words: [
						{ text: 'Hello', start: 0.5, end: 0.9 },
						{ text: 'there.', start: 0.95, end: 1.5 },
					],
				},
			],
			usage: { audioSeconds: 12 },
		});
	});

	it('asks for speakers and names them when the run diarizes', async () => {
		const sent = queueResponses(WHOLE_JOB);

		const result = await provider().transcribe(
			PAYLOAD,
			transcribeOptions({ diarize: true }),
		);

		expect(jsonBody<JobRequest>(at(sent, 1)).speaker_labels).toBe(true);
		expect(at(result.segments, 0).speaker).toBe('Speaker 1');
	});

	it('sends the language in the spelling the endpoint takes', async () => {
		const sent = queueResponses(WHOLE_JOB);

		await provider().transcribe(
			PAYLOAD,
			transcribeOptions({ language: 'en-US' }),
		);

		const job = jsonBody<JobRequest>(at(sent, 1));
		expect(job.language_code).toBe('en_us');
		// A named language and detection are alternatives
		expect(job.language_detection).toBeUndefined();
	});

	it('puts the generated terms ahead of the dictionary, each once', async () => {
		const sent = queueResponses(WHOLE_JOB);

		await provider().transcribe(
			PAYLOAD,
			transcribeOptions({
				keyterms: ['Kubernetes', 'etcd'],
				dictionary: ['Obsidian', 'kubernetes'],
			}),
		);

		expect(jsonBody<JobRequest>(at(sent, 1)).keyterms_prompt).toEqual([
			'Kubernetes',
			'etcd',
			'Obsidian',
		]);
	});

	it('trims a trailing slash off the configured endpoint', async () => {
		const sent = queueResponses(WHOLE_JOB);

		await provider({ baseUrl: `${BASE_URL}/` }).transcribe(
			PAYLOAD,
			transcribeOptions(),
		);

		expect(at(sent, 0).url).toBe(`${BASE_URL}/v2/upload`);
	});

	it('stops at an upload that names no place to read the recording from', async () => {
		const sent = queueResponses([answer({})]);

		await expect(
			provider().transcribe(PAYLOAD, transcribeOptions()),
		).rejects.toThrow('AssemblyAI upload did not return an upload URL.');
		expect(sent).toHaveLength(1);
	});

	it('stops at an upload answered with something other than an object', async () => {
		queueResponses([answer([])]);

		await expect(
			provider().transcribe(PAYLOAD, transcribeOptions()),
		).rejects.toThrow('AssemblyAI upload did not return an upload URL.');
	});

	it('stops at a job the endpoint gave no ID', async () => {
		const sent = queueResponses([UPLOADED, answer({ status: 'queued' })]);

		await expect(
			provider().transcribe(PAYLOAD, transcribeOptions()),
		).rejects.toThrow('AssemblyAI did not return a transcript ID.');
		expect(sent).toHaveLength(2);
	});

	it("reports a failed job with AssemblyAI's own reason", async () => {
		queueResponses([
			UPLOADED,
			QUEUED,
			answer({ status: 'error', error: 'Audio duration is too short.' }),
		]);

		await expect(
			provider().transcribe(PAYLOAD, transcribeOptions()),
		).rejects.toThrow(
			'AssemblyAI could not transcribe the recording: Audio duration is too short.',
		);
	});

	it('says so when a failed job names no reason', async () => {
		queueResponses([UPLOADED, QUEUED, answer({ status: 'error' })]);

		await expect(
			provider().transcribe(PAYLOAD, transcribeOptions()),
		).rejects.toThrow('no reason was given');
	});

	describe('a job AssemblyAI is still working on', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		/**
		 * How a job ends that is given two poll intervals to complete, read
		 * once three of them have passed.
		 * @returns The value or the error the run settled with
		 */
		const outcomePastTheLimit = async (): Promise<
			Awaited<ReturnType<typeof outcomeOf>>
		> => {
			const settled = outcomeOf(
				provider({
					requestTimeoutMs: ASSEMBLYAI_POLL_INTERVAL_MS * 2,
				}).transcribe(PAYLOAD, transcribeOptions()),
			);
			await jest.advanceTimersByTimeAsync(
				ASSEMBLYAI_POLL_INTERVAL_MS * 3,
			);
			return settled;
		};

		it('reads the status at the poll interval until the job completes', async () => {
			const sent = queueResponses([
				UPLOADED,
				QUEUED,
				PROCESSING,
				PROCESSING,
				COMPLETED,
				SENTENCES,
			]);

			const pending = provider().transcribe(PAYLOAD, transcribeOptions());
			await jest.advanceTimersByTimeAsync(
				ASSEMBLYAI_POLL_INTERVAL_MS - 1,
			);

			// Upload, queue and one status read: the second read waits
			expect(sent).toHaveLength(3);

			await jest.advanceTimersByTimeAsync(
				ASSEMBLYAI_POLL_INTERVAL_MS + 1,
			);

			expect((await pending).segments).toHaveLength(1);
			expect(sent).toHaveLength(6);
		});

		it('keeps waiting through a status it cannot read', async () => {
			const sent = queueResponses([
				UPLOADED,
				QUEUED,
				answer('not a status'),
				COMPLETED,
				SENTENCES,
			]);

			const pending = provider().transcribe(PAYLOAD, transcribeOptions());
			await jest.advanceTimersByTimeAsync(ASSEMBLYAI_POLL_INTERVAL_MS);

			expect((await pending).segments).toHaveLength(1);
			expect(sent).toHaveLength(5);
		});

		it.each([
			[
				'the status',
				[UPLOADED, QUEUED, UNAVAILABLE, COMPLETED, SENTENCES],
				['', '', '/sentences'],
			],
			[
				'the sentences',
				[UPLOADED, QUEUED, COMPLETED, UNAVAILABLE, SENTENCES],
				['', '/sentences', '/sentences'],
			],
		])(
			'reads %s again after a temporary refusal, on the job already queued',
			async (_read, answers, reads) => {
				const sent = queueResponses(answers);

				const result = await settleAcross(
					provider().transcribe(PAYLOAD, transcribeOptions()),
					ASSEMBLYAI_POLL_INTERVAL_MS,
				);

				expect(result.usage).toEqual({ audioSeconds: 12 });
				// A queued job is billed, so the recording goes up exactly once
				expect(sent.map((request) => request.url)).toEqual([
					`${BASE_URL}/v2/upload`,
					`${BASE_URL}/v2/transcript`,
					...reads.map(
						(suffix) => `${BASE_URL}/v2/transcript/job-1${suffix}`,
					),
				]);
			},
		);

		it('waits as long as the endpoint asks before reading again', async () => {
			const sent = queueResponses([
				UPLOADED,
				QUEUED,
				{ status: 429, headers: { 'Retry-After': '10' } },
				COMPLETED,
				SENTENCES,
			]);

			const pending = provider().transcribe(PAYLOAD, transcribeOptions());
			await jest.advanceTimersByTimeAsync(9_999);

			// Upload, queue and the refused read: the next one is not due yet
			expect(sent).toHaveLength(3);

			expect((await settleAcross(pending, 1)).language).toBe('en');
			expect(sent).toHaveLength(5);
		});

		it('waits out a dropped connection instead of abandoning the job', async () => {
			const answers = [UPLOADED, QUEUED, null, COMPLETED, SENTENCES];
			let calls = 0;
			withRequestUrl(() => {
				const next = answers[calls++];
				if (!next) {
					throw new Error('net::ERR_INTERNET_DISCONNECTED');
				}
				return { status: 200, headers: {}, text: '', ...next };
			});

			const result = await settleAcross(
				provider().transcribe(PAYLOAD, transcribeOptions()),
				ASSEMBLYAI_POLL_INTERVAL_MS,
			);

			expect(result.language).toBe('en');
			expect(calls).toBe(answers.length);
		});

		it('stops at once on a refusal that waiting cannot clear', async () => {
			const sent = queueResponses([
				UPLOADED,
				QUEUED,
				{ status: 401, text: 'Invalid API key' },
			]);

			await expect(
				provider().transcribe(PAYLOAD, transcribeOptions()),
			).rejects.toThrow('Authentication failed.');
			expect(sent).toHaveLength(3);
		});

		it('ends in a failure that cannot restart the job when the reads keep being refused', async () => {
			const sent = queueResponses([UPLOADED, QUEUED, UNAVAILABLE]);

			// Retryable would make the service call transcribe again, which
			// uploads the recording and queues a second paid job
			expect(await outcomePastTheLimit()).toEqual({
				error: expect.objectContaining({
					status: 503,
					retryable: false,
				}) as Error,
			});
			expect(
				sent.filter((request) => request.method === 'POST'),
			).toHaveLength(2);
		});

		it('gives up once the transcription limit has passed', async () => {
			queueResponses([UPLOADED, QUEUED, PROCESSING]);

			expect(await outcomePastTheLimit()).toEqual({
				error: expect.objectContaining({
					message:
						'Timed out waiting for AssemblyAI to transcribe the recording.',
				}) as Error,
			});
		});

		it('ends the wait when the run is cancelled between two reads', async () => {
			const sent = queueResponses([UPLOADED, QUEUED, PROCESSING]);
			const controller = new AbortController();
			const reason = new Error('Transcription cancelled');

			const settled = outcomeOf(
				provider().transcribe(
					PAYLOAD,
					transcribeOptions({ signal: controller.signal }),
				),
			);
			await jest.advanceTimersByTimeAsync(1);
			controller.abort(reason);

			expect(await settled).toEqual({ error: reason });
			expect(sent).toHaveLength(3);
		});
	});
});
