/**
 * Transcription via Soniox's asynchronous API, which works on a file it holds
 * rather than on a request body: the recording is uploaded
 * (`POST {baseUrl}/files`), a transcription is created over it
 * (`POST {baseUrl}/transcriptions`), its status is polled until it completes,
 * and the token transcript is read back
 * (`GET {baseUrl}/transcriptions/{id}/transcript`). Soniox keeps both objects
 * for thirty days and counts them against a quota, so they are deleted again
 * whether the run succeeded or not.
 *
 * Soniox detects the container itself and reads every one the plugin records,
 * the default `webm` included, so the payload is uploaded as it was lent. The
 * service has already decoded and split a recording the endpoint cannot take
 * whole, once per run for every engine.
 * @module transcription/providers/SonioxProvider
 */

import {
	SONIOX_POLL_BACKOFF_FACTOR,
	SONIOX_POLL_INITIAL_INTERVAL_MS,
	SONIOX_POLL_MAX_INTERVAL_MS,
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { EngineLabel } from '../../providers/providers';
import { delay } from '../../utils/TimeUtils';
import { dedupeTerms } from '../dictionary';
import { termsWithinSonioxContext } from '../dictionaryBias';
import {
	authHeader,
	buildMultipart,
	HttpError,
	requestJson,
	requestRaw,
	trimTrailingSlash,
	uploadTimeoutMs,
	type HttpResponse,
} from '../httpClient';
import { SONIOX_CAPABILITIES } from './capabilities';
import { isRecord } from './responseUtils';
import { mapSonioxTranscript } from './sonioxResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';
import type { WhisperResult } from './whisperResponse';

/** Status used for failures that never reached an HTTP response. */
const NO_HTTP_STATUS = 0;

/** A transcription that has not finished. */
const STATUS_QUEUED = 'queued';
const STATUS_PROCESSING = 'processing';
/** A transcription whose transcript can be read. */
const STATUS_COMPLETED = 'completed';
/** A transcription that failed; `error_message` says why. */
const STATUS_ERROR = 'error';

/** Configuration for the Soniox provider. */
export interface SonioxConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/**
	 * The user-configured transcription limit (ms). Caps each request, and is
	 * also how long a transcription is waited on once it is submitted.
	 */
	requestTimeoutMs?: number;
}

/** What a status poll answers with, reduced to the fields read. */
interface TranscriptionStatus {
	status: string;
	errorMessage: string | undefined;
	audioDurationMs: number | undefined;
}

/**
 * Reads the `id` out of an object-creating answer.
 * @param body - Parsed JSON answer
 * @param what - What was created, for the message
 */
function readId(body: unknown, what: string): string {
	if (!isRecord(body) || typeof body.id !== 'string' || body.id === '') {
		throw new HttpError(
			NO_HTTP_STATUS,
			`Soniox returned an unexpected response when creating the ${what}.`,
		);
	}
	return body.id;
}

/** Reads a status poll's answer. */
function readStatus(body: unknown): TranscriptionStatus {
	if (!isRecord(body) || typeof body.status !== 'string') {
		throw new HttpError(
			NO_HTTP_STATUS,
			'Soniox returned an unexpected transcription status.',
		);
	}
	const message = body.error_message;
	return {
		status: body.status,
		errorMessage:
			typeof message === 'string' && message !== '' ? message : undefined,
		audioDurationMs:
			typeof body.audio_duration_ms === 'number'
				? body.audio_duration_ms
				: undefined,
	};
}

/**
 * Soniox asynchronous transcription provider.
 */
export class SonioxProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.SONIOX;
	readonly label = EngineLabel.Soniox;
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = SONIOX_CAPABILITIES;

	constructor(private readonly config: SonioxConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		let fileId: string | undefined;
		let transcriptionId: string | undefined;
		try {
			fileId = await this.uploadFile(payload, options.signal);
			transcriptionId = await this.createTranscription(fileId, options);
			const { audioDurationMs } = await this.waitUntilDone(
				transcriptionId,
				options.signal,
			);
			const transcript = await requestJson<unknown>({
				url: this.url(`/transcriptions/${transcriptionId}/transcript`),
				method: 'GET',
				headers: this.headers(),
				signal: options.signal,
			});
			return mapSonioxTranscript(transcript, {
				diarize: options.diarize,
				audioDurationMs,
			});
		} finally {
			const cleanup = this.discard(transcriptionId, fileId);
			// A cancelled run is released at once rather than after the two
			// deletes, which have nothing left to tell it.
			if (options.signal?.aborted) {
				void cleanup;
			} else {
				await cleanup;
			}
		}
	}

	/** The URL of a path under the configured base. */
	private url(path: string): string {
		return `${trimTrailingSlash(this.config.baseUrl)}${path}`;
	}

	/** The authorization header, or nothing for an endpoint that takes no key. */
	private headers(): Record<string, string> {
		return authHeader('Authorization', this.config.apiKey, 'Bearer');
	}

	/**
	 * Uploads the recording to Soniox's file store.
	 * @param payload - The audio as it was lent
	 * @param signal - The run's cancel
	 * @returns The id the file is stored under
	 */
	private async uploadFile(
		payload: AudioPayload,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const { body, contentType } = buildMultipart([
			{
				type: 'file',
				name: 'file',
				filename: payload.filename,
				contentType: payload.contentType,
				data: payload.data,
			},
		]);
		const answer = await requestJson<unknown>({
			url: this.url('/files'),
			method: 'POST',
			headers: this.headers(),
			contentType,
			body,
			timeoutMs: uploadTimeoutMs(
				body.byteLength,
				this.config.requestTimeoutMs,
			),
			signal,
			// A Cancel or the deadline can release the run while Soniox is
			// still taking the bytes, and the file they make up is named only
			// in the answer that arrives afterwards.
			onAbandoned: (late) => {
				void this.discardLate('/files', late);
			},
		});
		return readId(answer, 'file');
	}

	/**
	 * Starts the transcription of an uploaded file.
	 * @param fileId - The uploaded file's id
	 * @param options - Transcription options
	 * @returns The id of the transcription
	 */
	private async createTranscription(
		fileId: string,
		options: TranscribeOptions,
	): Promise<string> {
		const request: Record<string, unknown> = {
			model: this.config.model,
			file_id: fileId,
			// Costs nothing extra, and puts the language on every token, which
			// is where the transcript's own language is read from.
			enable_language_identification: true,
		};
		if (options.diarize) {
			request.enable_speaker_diarization = true;
		}
		const hint = languageHint(options.language);
		if (hint) {
			request.language_hints = [hint];
		}
		const terms = this.biasTerms(options);
		if (terms.length > 0) {
			request.context = { terms };
		}
		const created = await requestJson<unknown>({
			url: this.url('/transcriptions'),
			method: 'POST',
			headers: this.headers(),
			contentType: 'application/json',
			body: JSON.stringify(request),
			signal: options.signal,
			onAbandoned: (late) => {
				void this.discardLate('/transcriptions', late);
			},
		});
		return readId(created, 'transcription');
	}

	/**
	 * Polls the transcription until it completes, with a pause that grows from
	 * a second to ten, for as long as the user's transcription limit allows.
	 * @param transcriptionId - The transcription's id
	 * @param signal - Ends the wait when the run is cancelled, mid-request or
	 *   mid-pause alike
	 * @returns The final status
	 */
	private async waitUntilDone(
		transcriptionId: string,
		signal: AbortSignal | undefined,
	): Promise<TranscriptionStatus> {
		const deadline =
			Date.now() +
			(this.config.requestTimeoutMs ?? TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS);
		let interval = SONIOX_POLL_INITIAL_INTERVAL_MS;
		for (;;) {
			await delay(interval, signal);
			const status = readStatus(
				await requestJson<unknown>({
					url: this.url(`/transcriptions/${transcriptionId}`),
					method: 'GET',
					headers: this.headers(),
					signal,
				}),
			);
			if (status.status === STATUS_COMPLETED) {
				return status;
			}
			if (status.status === STATUS_ERROR) {
				throw new HttpError(
					NO_HTTP_STATUS,
					`Soniox could not transcribe the recording: ${status.errorMessage ?? 'no reason given'}.`,
				);
			}
			if (
				status.status !== STATUS_QUEUED &&
				status.status !== STATUS_PROCESSING
			) {
				throw new HttpError(
					NO_HTTP_STATUS,
					`Soniox reported an unknown transcription status "${status.status}".`,
				);
			}
			if (Date.now() >= deadline) {
				throw new HttpError(
					NO_HTTP_STATUS,
					'Timed out waiting for Soniox to finish the transcription. Raise the transcription time limit in settings for a longer recording.',
				);
			}
			interval = Math.min(
				Math.round(interval * SONIOX_POLL_BACKOFF_FACTOR),
				SONIOX_POLL_MAX_INTERVAL_MS,
			);
		}
	}

	/**
	 * The terms this run biases recognition toward, as `context.terms` takes
	 * them. Generated keyterms from the advanced second pass go ahead of the
	 * user's dictionary in one combined list, so when the size limit bites the
	 * context mined from this very recording wins over the static glossary.
	 * @param options - Transcription options
	 * @returns The terms to send, empty when the run biases nothing
	 */
	private biasTerms(options: TranscribeOptions): string[] {
		return termsWithinSonioxContext(
			dedupeTerms([
				...(options.keyterms ?? []),
				...(options.dictionary ?? []),
			]),
		);
	}

	/**
	 * Deletes what the run created, the transcription first and the file after
	 * it. Best effort and never throws: both expire on Soniox's side after
	 * thirty days, and a failed delete must not replace the run's own result
	 * or error.
	 * @param transcriptionId - The transcription, when one was created
	 * @param fileId - The file, when one was uploaded
	 */
	private async discard(
		transcriptionId: string | undefined,
		fileId: string | undefined,
	): Promise<void> {
		if (transcriptionId !== undefined) {
			await this.deleteQuietly(`/transcriptions/${transcriptionId}`);
		}
		if (fileId !== undefined) {
			await this.deleteQuietly(`/files/${fileId}`);
		}
	}

	/**
	 * Deletes what an upload or a create request made after the run had
	 * stopped waiting for it, naming it from the answer that came too late.
	 * @param collection - `/files` or `/transcriptions`
	 * @param late - The answer that arrived after the caller left
	 */
	private async discardLate(
		collection: string,
		late: HttpResponse,
	): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(late.text);
			await this.deleteQuietly(
				`${collection}/${readId(parsed, 'object')}`,
			);
		} catch {
			// Nobody is left to tell, and what survives expires on Soniox's
			// side.
		}
	}

	/** Sends one DELETE and swallows its failure. */
	private async deleteQuietly(path: string): Promise<void> {
		try {
			await requestRaw({
				url: this.url(path),
				method: 'DELETE',
				headers: this.headers(),
			});
		} catch {
			// See discard: a leftover object is not worth failing the run for.
		}
	}
}

/**
 * The language code `language_hints` takes: the primary subtag of the
 * configured code, lowercased, because Soniox names a language by its two-
 * letter ISO code and the field also accepts regional forms such as `pt-BR`.
 * @param language - The configured language, when one is
 * @returns The code to hint, or undefined for none
 */
function languageHint(language: string | undefined): string | undefined {
	const primary = language?.trim().split('-')[0]?.toLowerCase();
	return primary ? primary : undefined;
}
