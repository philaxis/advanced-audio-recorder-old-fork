/**
 * Tests for the SonioxProvider run: the upload, the transcription it creates
 * and what that request carries (diarization, language hint, context terms),
 * the status polling with its growing pause and its two ways of ending badly,
 * the transcript it reads back, and the cleanup of the file and the
 * transcription that happens whatever the outcome. Obsidian's requestUrl is
 * scripted through the shared mock handler, one answer per endpoint.
 *
 * What the capability says about containers and the 300-minute cap belongs to
 * the capability and to audio preparation, and is tested there.
 */

import {
	SONIOX_CONTEXT_TOKEN_BUDGET,
	SONIOX_POLL_INITIAL_INTERVAL_MS,
	SONIOX_POLL_MAX_INTERVAL_MS,
} from 'src/constants';
import { termsWithinSonioxContext } from 'src/transcription/dictionaryBias';
import { SonioxProvider } from 'src/transcription/providers/SonioxProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import type { WhisperResult } from 'src/transcription/providers/whisperResponse';
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { at } from '../helpers/assertions';
import { type Outcome, outcomeOf, settleAcross } from '../helpers/async';
import { requestBodyText, withRequestUrl } from '../helpers/network';
import { transcribeOptions } from '../helpers/providerFixtures';

const BASE_URL = 'https://soniox.example/v1';
const MODEL = 'stt-async-v6';
const FILE_ID = 'file-1';
const TRANSCRIPTION_ID = 'tr-1';

const PAYLOAD: AudioPayload = {
	data: new ArrayBuffer(8),
	contentType: 'audio/webm',
	filename: 'rec.webm',
	offsetSeconds: 0,
};

const TRANSCRIPT = {
	id: TRANSCRIPTION_ID,
	text: '안녕하세요.',
	tokens: [
		{
			text: '안녕하세요.',
			start_ms: 100,
			end_ms: 900,
			confidence: 0.99,
			speaker: '1',
			language: 'ko',
		},
	],
};

/** A JSON answer with the given status. */
function json(body: unknown, status = 200): MockRequestUrlResponse {
	return { status, headers: {}, text: JSON.stringify(body) };
}

/** A status poll's answer. */
function status(
	state: string,
	extra: Record<string, unknown> = {},
): MockRequestUrlResponse {
	return json({ id: TRANSCRIPTION_ID, status: state, ...extra });
}

/** What each endpoint of the scripted API answers with. */
interface Script {
	upload?: () => MockRequestUrlResponse | Promise<MockRequestUrlResponse>;
	create?: () => MockRequestUrlResponse | Promise<MockRequestUrlResponse>;
	/** The status polls, answered in order; the last one repeats. */
	polls?: MockRequestUrlResponse[];
	transcript?: () => MockRequestUrlResponse;
	deleteTranscription?: () => MockRequestUrlResponse;
	deleteFile?: () => MockRequestUrlResponse;
}

/**
 * Plays Soniox: answers each endpoint from the script, defaulting to a
 * successful run that completes at the first poll, and records every request.
 * @param script - What to change about the default run
 * @returns The requests, in the order they were made
 */
function playSoniox(script: Script = {}): MockRequestUrlParam[] {
	const calls: MockRequestUrlParam[] = [];
	const polls = script.polls ?? [
		status('completed', { audio_duration_ms: 13320 }),
	];
	let polled = 0;
	withRequestUrl(
		(param): MockRequestUrlResponse | Promise<MockRequestUrlResponse> => {
			calls.push(param);
			const { method, url } = param;
			if (method === 'POST' && url.endsWith('/files')) {
				return script.upload?.() ?? json({ id: FILE_ID }, 201);
			}
			if (method === 'POST' && url.endsWith('/transcriptions')) {
				return (
					script.create?.() ??
					json({ id: TRANSCRIPTION_ID, status: 'queued' }, 201)
				);
			}
			if (method === 'GET' && url.endsWith('/transcript')) {
				return script.transcript?.() ?? json(TRANSCRIPT);
			}
			if (method === 'GET') {
				const answer = polls[Math.min(polled, polls.length - 1)];
				polled += 1;
				return answer ?? status('completed');
			}
			if (url.endsWith(`/transcriptions/${TRANSCRIPTION_ID}`)) {
				return (
					script.deleteTranscription?.() ?? {
						status: 204,
						headers: {},
						text: '',
					}
				);
			}
			return (
				script.deleteFile?.() ?? { status: 204, headers: {}, text: '' }
			);
		},
	);
	return calls;
}

function provider(requestTimeoutMs?: number): SonioxProvider {
	return new SonioxProvider({
		baseUrl: BASE_URL,
		apiKey: 'sx-key',
		model: MODEL,
		...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
	});
}

/** The requests that went to one method and path suffix. */
function requestsTo(
	calls: MockRequestUrlParam[],
	method: string,
	suffix: string,
): MockRequestUrlParam[] {
	return calls.filter(
		(call) => call.method === method && call.url.endsWith(suffix),
	);
}

/** The paths the run deleted, in the order it deleted them. */
function deletedPaths(calls: MockRequestUrlParam[]): string[] {
	return calls
		.filter((call) => call.method === 'DELETE')
		.map((call) => call.url.slice(BASE_URL.length));
}

/** A run started on the fake clock that the returned controller can cancel. */
function startCancellable(): {
	controller: AbortController;
	settled: Promise<Outcome<WhisperResult>>;
} {
	const controller = new AbortController();
	const settled = outcomeOf(
		provider().transcribe(
			PAYLOAD,
			transcribeOptions({ signal: controller.signal }),
		),
	);
	return { controller, settled };
}

/** The JSON body the transcription was created with. */
function createdBody(calls: MockRequestUrlParam[]): Record<string, unknown> {
	const create = calls.find(
		(call) =>
			call.method === 'POST' && call.url.endsWith('/transcriptions'),
	);
	if (typeof create?.body !== 'string') {
		throw new Error('The transcription was never created');
	}
	return JSON.parse(create.body) as Record<string, unknown>;
}

/**
 * Runs the provider against the scripted API on the fake clock, past every
 * pause it takes.
 * @param options - Transcription options for the run
 * @param elapseMs - How far to move the clock
 */
function run(
	options = transcribeOptions(),
	elapseMs = SONIOX_POLL_INITIAL_INTERVAL_MS,
): Promise<WhisperResult> {
	return settleAcross(provider().transcribe(PAYLOAD, options), elapseMs);
}

describe('SonioxProvider', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	describe('the sequence of a run', () => {
		it('uploads, creates, polls, reads the transcript, then deletes both', async () => {
			const calls = playSoniox();

			const result = await run();

			expect(
				calls.map(
					(call) =>
						`${call.method} ${call.url.slice(BASE_URL.length)}`,
				),
			).toEqual([
				'POST /files',
				'POST /transcriptions',
				`GET /transcriptions/${TRANSCRIPTION_ID}`,
				`GET /transcriptions/${TRANSCRIPTION_ID}/transcript`,
				`DELETE /transcriptions/${TRANSCRIPTION_ID}`,
				`DELETE /files/${FILE_ID}`,
			]);
			expect(result.segments).toEqual([
				{
					start: 0.1,
					end: 0.9,
					text: '안녕하세요.',
					words: [{ text: '안녕하세요.', start: 0.1, end: 0.9 }],
				},
			]);
			expect(result.language).toBe('ko');
		});

		it('sends the bearer key on every request', async () => {
			const calls = playSoniox();

			await run();

			expect(
				calls.every(
					(call) => call.headers?.Authorization === 'Bearer sx-key',
				),
			).toBe(true);
		});

		it('sends no authorization header when there is no key', async () => {
			const calls = playSoniox();

			await settleAcross(
				new SonioxProvider({
					baseUrl: BASE_URL,
					apiKey: '',
					model: MODEL,
				}).transcribe(PAYLOAD, transcribeOptions()),
				SONIOX_POLL_INITIAL_INTERVAL_MS,
			);

			expect(
				calls.some((call) => 'Authorization' in (call.headers ?? {})),
			).toBe(false);
		});

		it('reports the audio length the transcription measured as billed usage', async () => {
			playSoniox();

			const result = await run();

			expect(result.usage).toEqual({ audioSeconds: 13.32 });
		});
	});

	describe('the upload', () => {
		it('posts the payload untouched as the multipart file field', async () => {
			const calls = playSoniox();

			await run();

			const upload = at(requestsTo(calls, 'POST', '/files'), 0);
			expect(upload.contentType).toMatch(
				/^multipart\/form-data; boundary=/,
			);
			const body = requestBodyText(calls, 0);
			expect(body).toContain('name="file"; filename="rec.webm"');
			expect(body).toContain('Content-Type: audio/webm');
		});

		it('does not create a transcription when the upload is refused', async () => {
			const calls = playSoniox({
				upload: () => json({ error_message: 'file too long' }, 400),
			});

			await expect(run()).rejects.toThrow(/status 400/);

			expect(calls).toHaveLength(1);
		});

		it('rejects an upload answer that names no file', async () => {
			const calls = playSoniox({ upload: () => json({}, 201) });

			await expect(run()).rejects.toThrow(/creating the file/);

			expect(calls).toHaveLength(1);
		});
	});

	describe('the transcription request', () => {
		it('names the model and the uploaded file and asks for language identification', async () => {
			const calls = playSoniox();

			await run();

			expect(createdBody(calls)).toEqual({
				model: MODEL,
				file_id: FILE_ID,
				enable_language_identification: true,
			});
		});

		it('posts it as JSON', async () => {
			const calls = playSoniox();

			await run();

			expect(
				at(requestsTo(calls, 'POST', '/transcriptions'), 0).contentType,
			).toBe('application/json');
		});

		it('asks for speaker diarization only when the run wants it', async () => {
			const diarized = playSoniox();
			await run(transcribeOptions({ diarize: true }));
			const plain = playSoniox();
			await run(transcribeOptions({ diarize: false }));

			expect(createdBody(diarized).enable_speaker_diarization).toBe(true);
			expect(createdBody(plain)).not.toHaveProperty(
				'enable_speaker_diarization',
			);
		});

		it('labels the speakers it gets back when diarizing', async () => {
			playSoniox();

			const result = await run(transcribeOptions({ diarize: true }));

			expect(at(result.segments, 0).speaker).toBe('Speaker 1');
		});

		it('sends the language as a one-element hint', async () => {
			const calls = playSoniox();

			await run(transcribeOptions({ language: 'ko' }));

			expect(createdBody(calls).language_hints).toEqual(['ko']);
		});

		it.each([
			{ configured: 'pt-BR', sent: 'pt' },
			{ configured: ' KO ', sent: 'ko' },
		])(
			'sends only the primary subtag of $configured',
			async ({ configured, sent }) => {
				const calls = playSoniox();

				await run(transcribeOptions({ language: configured }));

				expect(createdBody(calls).language_hints).toEqual([sent]);
			},
		);

		it('sends no hint when the language is left to detection', async () => {
			const calls = playSoniox();

			await run(transcribeOptions());

			expect(createdBody(calls)).not.toHaveProperty('language_hints');
		});
	});

	describe('the dictionary as context terms', () => {
		it('sends no context when the run biases nothing', async () => {
			const calls = playSoniox();

			await run(transcribeOptions({ dictionary: [], keyterms: [] }));

			expect(createdBody(calls)).not.toHaveProperty('context');
		});

		it('sends the terms as written under context.terms', async () => {
			const calls = playSoniox();

			await run(
				transcribeOptions({
					dictionary: ['이그니스', 'Obsidian Sync'],
				}),
			);

			expect(createdBody(calls).context).toEqual({
				terms: ['이그니스', 'Obsidian Sync'],
			});
		});

		it('puts the generated keyterms ahead of the dictionary and drops repeats', async () => {
			const calls = playSoniox();

			await run(
				transcribeOptions({
					keyterms: ['Gemini', '소니옥스'],
					dictionary: ['gemini', '이그니스'],
				}),
			);

			expect(createdBody(calls).context).toEqual({
				terms: ['Gemini', '소니옥스', '이그니스'],
			});
		});

		it('keeps the list within the context budget, the leading terms first', async () => {
			const calls = playSoniox();
			const dictionary = Array.from(
				{ length: 2000 },
				(_, index) => `term-number-${String(index)}`,
			);

			await run(transcribeOptions({ dictionary }));

			const { terms } = createdBody(calls).context as { terms: string[] };
			expect(terms.length).toBeGreaterThan(0);
			expect(terms.length).toBeLessThan(dictionary.length);
			expect(terms).toEqual(dictionary.slice(0, terms.length));
			expect(termsWithinSonioxContext(terms)).toEqual(terms);
			expect(
				new TextEncoder().encode(terms.join('')).length,
			).toBeLessThanOrEqual(SONIOX_CONTEXT_TOKEN_BUDGET);
		});
	});

	describe('polling', () => {
		it('waits the first pause before the first poll', async () => {
			const calls = playSoniox();

			const pending = outcomeOf(
				provider().transcribe(PAYLOAD, transcribeOptions()),
			);
			await jest.advanceTimersByTimeAsync(
				SONIOX_POLL_INITIAL_INTERVAL_MS - 1,
			);

			expect(
				requestsTo(calls, 'GET', `/transcriptions/${TRANSCRIPTION_ID}`),
			).toHaveLength(0);

			await jest.advanceTimersByTimeAsync(1);
			await pending;

			expect(
				requestsTo(calls, 'GET', `/transcriptions/${TRANSCRIPTION_ID}`),
			).toHaveLength(1);
		});

		it('keeps polling while the job is queued or processing, then reads the transcript', async () => {
			const calls = playSoniox({
				polls: [
					status('queued'),
					status('processing'),
					status('completed'),
				],
			});

			await run(transcribeOptions(), SONIOX_POLL_MAX_INTERVAL_MS * 3);

			expect(
				requestsTo(calls, 'GET', `/transcriptions/${TRANSCRIPTION_ID}`),
			).toHaveLength(3);
			expect(requestsTo(calls, 'GET', '/transcript')).toHaveLength(1);
		});

		it('lets the pause between polls grow by half each time, up to its ceiling', async () => {
			const askedAt: number[] = [];
			const started = Date.now();
			withRequestUrl((param): MockRequestUrlResponse => {
				if (param.method === 'POST') {
					return json({ id: FILE_ID }, 201);
				}
				if (param.method === 'GET') {
					askedAt.push(Date.now() - started);
				}
				return status('processing');
			});

			const settled = outcomeOf(
				provider(10 * 60_000).transcribe(PAYLOAD, transcribeOptions()),
			);
			await jest.advanceTimersByTimeAsync(60_000);

			const gaps = askedAt
				.slice(1)
				.map((time, index) => time - at(askedAt, index));
			expect(askedAt[0]).toBe(SONIOX_POLL_INITIAL_INTERVAL_MS);
			expect(gaps.slice(0, 5)).toEqual([1500, 2250, 3375, 5063, 7595]);
			expect(gaps.slice(5)).toEqual(
				gaps.slice(5).map(() => SONIOX_POLL_MAX_INTERVAL_MS),
			);
			await jest.advanceTimersByTimeAsync(10 * 60_000);
			await settled;
		});

		it('fails with the reason Soniox gave when the job ends in error', async () => {
			playSoniox({
				polls: [
					status('processing'),
					status('error', {
						error_type: 'invalid_audio',
						error_message: 'Audio could not be decoded',
					}),
				],
			});

			await expect(
				run(transcribeOptions(), SONIOX_POLL_MAX_INTERVAL_MS * 2),
			).rejects.toThrow(
				'Soniox could not transcribe the recording: Audio could not be decoded.',
			);
		});

		it('says so when an errored job gives no reason', async () => {
			playSoniox({ polls: [status('error')] });

			await expect(run()).rejects.toThrow(/no reason given/);
		});

		it('does not read a transcript for a job that errored', async () => {
			const calls = playSoniox({
				polls: [status('error', { error_message: 'bad' })],
			});

			await expect(run()).rejects.toThrow();

			expect(requestsTo(calls, 'GET', '/transcript')).toHaveLength(0);
		});

		it('rejects a status it does not know instead of polling forever', async () => {
			playSoniox({ polls: [status('paused')] });

			await expect(run()).rejects.toThrow(
				/unknown transcription status "paused"/,
			);
		});

		it('rejects a status answer that carries no status', async () => {
			playSoniox({ polls: [json({ id: TRANSCRIPTION_ID })] });

			await expect(run()).rejects.toThrow(
				/unexpected transcription status/,
			);
		});

		it('gives up once the transcription limit is spent', async () => {
			playSoniox({ polls: [status('processing')] });

			const settled = outcomeOf(
				provider(5000).transcribe(PAYLOAD, transcribeOptions()),
			);
			await jest.advanceTimersByTimeAsync(
				5000 + SONIOX_POLL_MAX_INTERVAL_MS,
			);

			expect(await settled).toEqual({
				error: expect.objectContaining({
					message: expect.stringMatching(
						/timed out waiting for Soniox/i,
					),
				}),
			});
		});
	});

	describe('cleanup', () => {
		const BOTH = [
			`/transcriptions/${TRANSCRIPTION_ID}`,
			`/files/${FILE_ID}`,
		];

		it('deletes the transcription before the file', async () => {
			const calls = playSoniox();

			await run();

			expect(deletedPaths(calls)).toEqual(BOTH);
		});

		it('still deletes both when the job ends in error', async () => {
			const calls = playSoniox({
				polls: [status('error', { error_message: 'bad' })],
			});

			await expect(run()).rejects.toThrow();

			expect(deletedPaths(calls)).toEqual(BOTH);
		});

		it('still deletes both when the transcript cannot be read', async () => {
			const calls = playSoniox({ transcript: () => json({}, 500) });

			await expect(run()).rejects.toThrow(/status 500/);

			expect(deletedPaths(calls)).toEqual(BOTH);
		});

		it('deletes only the file when the transcription was never created', async () => {
			const calls = playSoniox({
				create: () => json({ error_message: 'bad' }, 400),
			});

			await expect(run()).rejects.toThrow(/status 400/);

			expect(deletedPaths(calls)).toEqual([`/files/${FILE_ID}`]);
		});

		it('deletes nothing when the upload itself failed', async () => {
			const calls = playSoniox({ upload: () => json({}, 401) });

			await expect(run()).rejects.toThrow(/Authentication failed/);

			expect(deletedPaths(calls)).toEqual([]);
		});

		it('does not let a failed delete replace the result', async () => {
			playSoniox({
				deleteTranscription: () => json({}, 409),
				deleteFile: () => json({}, 500),
			});

			const result = await run();

			expect(at(result.segments, 0).text).toBe('안녕하세요.');
		});

		it('still tries the file when deleting the transcription failed', async () => {
			const calls = playSoniox({
				deleteTranscription: () => json({}, 409),
			});

			await run();

			expect(deletedPaths(calls)).toEqual(BOTH);
		});
	});

	describe('cancelling the run', () => {
		it('ends the wait between polls and deletes what was created', async () => {
			const calls = playSoniox({ polls: [status('processing')] });
			const reason = new Error('Transcription cancelled');
			const { controller, settled } = startCancellable();
			await jest.advanceTimersByTimeAsync(
				SONIOX_POLL_INITIAL_INTERVAL_MS,
			);

			controller.abort(reason);

			expect(await settled).toEqual({ error: reason });
			// A cancelled run does not wait for the deletes, so let them land.
			await jest.advanceTimersByTimeAsync(0);
			expect(deletedPaths(calls)).toEqual([
				`/transcriptions/${TRANSCRIPTION_ID}`,
				`/files/${FILE_ID}`,
			]);
		});

		it('is released at once from a poll the endpoint has not answered', async () => {
			let polling = false;
			withRequestUrl((param) => {
				if (param.method === 'POST') {
					return json({ id: FILE_ID }, 201);
				}
				if (param.method === 'GET') {
					polling = true;
					return new Promise<MockRequestUrlResponse>(() => undefined);
				}
				return { status: 204, headers: {}, text: '' };
			});
			const { controller, settled } = startCancellable();
			await jest.advanceTimersByTimeAsync(
				SONIOX_POLL_INITIAL_INTERVAL_MS,
			);
			expect(polling).toBe(true);

			controller.abort();

			const outcome = await settled;
			expect(outcome).toHaveProperty('error');
			expect(String((outcome as { error: Error }).error.message)).toMatch(
				/was cancelled/,
			);
		});

		it('deletes the file an upload made after the run stopped waiting for it', async () => {
			let answerUpload = (): void => undefined;
			const answered = new Promise<void>((resolve) => {
				answerUpload = resolve;
			});
			const calls = playSoniox({
				upload: () =>
					answered.then(() => json({ id: 'late-file' }, 201)),
			});
			const { controller, settled } = startCancellable();
			await jest.advanceTimersByTimeAsync(1);

			controller.abort();
			await settled;
			answerUpload();
			await jest.advanceTimersByTimeAsync(0);

			expect(deletedPaths(calls)).toEqual(['/files/late-file']);
		});
	});
});
