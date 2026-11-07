/**
 * Pure mapping of a Soniox `GET /transcriptions/{id}/transcript` response into
 * the plugin's transcript segment model. The endpoint answers with the full
 * text and a flat list of tokens, each carrying its own timing, speaker and
 * language, but no sentence or utterance boundaries, so the segments and the
 * words are built here from the tokens.
 *
 * Tolerant of missing or malformed fields so a surprising response degrades to
 * "best available" rather than throwing.
 * @module transcription/providers/sonioxResponse
 */

import { MS_PER_SECOND } from '../../constants';
import type {
	TranscriptSegment,
	TranscriptWord,
	TranscriptionUsage,
} from '../TranscriptTypes';
import { isRecord, num } from './responseUtils';
import type { WhisperResult } from './whisperResponse';

/** One token of the transcript, reduced to the fields the mapping reads. */
interface SonioxToken {
	/** The piece of text, with the leading space that marks a new word. */
	text: string;
	startMs: number;
	endMs: number;
	/** The speaker as Soniox numbers them ("1", "2", ...), when it labelled one. */
	speaker: string | undefined;
	language: string | undefined;
}

/** What the caller knows about the run that the transcript does not say. */
export interface SonioxMapOptions {
	/** Whether diarization was requested; gates the speaker labels. */
	diarize: boolean;
	/** The audio length the transcription reports, when it did. */
	audioDurationMs?: number | undefined;
}

/**
 * A sentence ends at one of these, optionally followed by closing quotes or
 * brackets. The full-width forms are the sentence enders of Chinese and
 * Japanese, which Soniox writes without a space after them.
 */
const SENTENCE_END = /[.!?。！？\u2026]["'\u201d\u2019」』)\]]*$/;

/** The sentence enders that need no whitespace after them to end a sentence. */
const FULL_WIDTH_SENTENCE_END = /[。！？]["'\u201d\u2019」』)\]]*$/;

/** Whether text begins with whitespace, which is how Soniox marks a new word. */
const STARTS_WITH_SPACE = /^\s/;

/** Whether text ends with whitespace, after which the next token is a new word. */
const ENDS_WITH_SPACE = /\s$/;

/** Reads a token, or null for an entry that is not one. */
function readToken(entry: unknown): SonioxToken | null {
	if (!isRecord(entry) || typeof entry.text !== 'string') {
		return null;
	}
	const speaker =
		typeof entry.speaker === 'string' || typeof entry.speaker === 'number'
			? String(entry.speaker)
			: undefined;
	const start = num(entry.start_ms);
	return {
		text: entry.text,
		startMs: start,
		endMs: num(entry.end_ms, start),
		speaker,
		language:
			typeof entry.language === 'string' && entry.language !== ''
				? entry.language
				: undefined,
	};
}

/**
 * Whether a sentence ends after this token. A terminator inside a word ("3.5",
 * "U.S.") is not an end, because the next token continues the word without a
 * space; the full-width enders carry no space and are always an end.
 */
function endsSentence(
	token: SonioxToken,
	next: SonioxToken | undefined,
): boolean {
	const text = token.text.trimEnd();
	if (!SENTENCE_END.test(text)) {
		return false;
	}
	return (
		next === undefined ||
		STARTS_WITH_SPACE.test(next.text) ||
		ENDS_WITH_SPACE.test(token.text) ||
		FULL_WIDTH_SENTENCE_END.test(text)
	);
}

/**
 * Splits tokens into runs that each form one segment: a run ends at a sentence
 * end and wherever the speaker changes. A token without a speaker belongs to
 * the speaker before it, so a stray unlabelled token never splits a turn.
 */
function segmentRuns(tokens: SonioxToken[], diarize: boolean): SonioxToken[][] {
	const runs: SonioxToken[][] = [];
	let run: SonioxToken[] = [];
	let speaker: string | undefined;
	tokens.forEach((token, index) => {
		if (
			diarize &&
			run.length > 0 &&
			token.speaker !== undefined &&
			token.speaker !== speaker
		) {
			runs.push(run);
			run = [];
		}
		if (diarize && token.speaker !== undefined) {
			speaker = token.speaker;
		}
		run.push(token);
		if (endsSentence(token, tokens[index + 1])) {
			runs.push(run);
			run = [];
		}
	});
	if (run.length > 0) {
		runs.push(run);
	}
	return runs;
}

/**
 * Joins the sub-word tokens of a run into words. A token that starts with
 * whitespace, or follows one that ends with it, begins a new word; Korean and
 * other space-delimited scripts split on their word spaces this way. A script
 * written without spaces yields one word per space-free stretch, which is as
 * fine as the text itself allows.
 */
function runWords(run: SonioxToken[]): TranscriptWord[] {
	const words: TranscriptWord[] = [];
	let current: TranscriptWord | null = null;
	let previousEndedWithSpace = false;
	for (const token of run) {
		const piece = token.text.trim();
		if (piece === '') {
			current = null;
			previousEndedWithSpace = false;
			continue;
		}
		if (
			current === null ||
			previousEndedWithSpace ||
			STARTS_WITH_SPACE.test(token.text)
		) {
			current = {
				text: piece,
				start: token.startMs / MS_PER_SECOND,
				end: token.endMs / MS_PER_SECOND,
			};
			words.push(current);
		} else {
			current.text += piece;
			current.end = token.endMs / MS_PER_SECOND;
		}
		previousEndedWithSpace = ENDS_WITH_SPACE.test(token.text);
	}
	return words;
}

/** Builds the segment a run of tokens makes, or null when it holds no text. */
function runSegment(
	run: SonioxToken[],
	diarize: boolean,
): TranscriptSegment | null {
	// Soniox's own spacing is kept rather than rebuilt from the words, so a
	// script written without spaces is not given any.
	const text = run
		.map((token) => token.text)
		.join('')
		.trim();
	const first = run[0];
	const last = run[run.length - 1];
	if (text === '' || !first || !last) {
		return null;
	}
	const speakerId = diarize
		? run.find((token) => token.speaker !== undefined)?.speaker
		: undefined;
	const words = runWords(run);
	return {
		start: first.startMs / MS_PER_SECOND,
		end: last.endMs / MS_PER_SECOND,
		text,
		...(speakerId === undefined ? {} : { speaker: `Speaker ${speakerId}` }),
		...(words.length > 0 ? { words } : {}),
	};
}

/**
 * The language most of the transcript is in, counted by characters so a run of
 * short replies in one language does not outvote a long passage in another.
 */
function dominantLanguage(tokens: SonioxToken[]): string | undefined {
	const counts = new Map<string, number>();
	for (const token of tokens) {
		if (token.language !== undefined) {
			counts.set(
				token.language,
				(counts.get(token.language) ?? 0) + token.text.trim().length,
			);
		}
	}
	let best: { language: string; count: number } | undefined;
	for (const [language, count] of counts) {
		if (!best || count > best.count) {
			best = { language, count };
		}
	}
	return best?.language;
}

/** The billed audio length the transcription reported, when it is usable. */
function sonioxUsage(
	audioDurationMs: number | undefined,
): TranscriptionUsage | undefined {
	return typeof audioDurationMs === 'number' &&
		Number.isFinite(audioDurationMs) &&
		audioDurationMs >= 0
		? { audioSeconds: audioDurationMs / MS_PER_SECOND }
		: undefined;
}

/**
 * Maps a Soniox transcript response to a WhisperResult. Falls back to a single
 * segment built from the top-level `text` when the response carries no tokens.
 * @param body - Parsed JSON response body
 * @param options - What the run asked for and the audio length it reported
 */
export function mapSonioxTranscript(
	body: unknown,
	options: SonioxMapOptions,
): WhisperResult {
	const usage = sonioxUsage(options.audioDurationMs);
	if (!isRecord(body)) {
		return { segments: [], ...(usage ? { usage } : {}) };
	}
	const tokens: SonioxToken[] = [];
	if (Array.isArray(body.tokens)) {
		for (const entry of body.tokens) {
			const token = readToken(entry);
			if (token) {
				tokens.push(token);
			}
		}
	}
	const language = dominantLanguage(tokens);
	const segments: TranscriptSegment[] = [];
	for (const run of segmentRuns(tokens, options.diarize)) {
		const segment = runSegment(run, options.diarize);
		if (segment) {
			segments.push(segment);
		}
	}
	if (segments.length === 0) {
		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (text !== '') {
			segments.push({ start: 0, end: 0, text });
		}
	}
	return { language, segments, ...(usage ? { usage } : {}) };
}
