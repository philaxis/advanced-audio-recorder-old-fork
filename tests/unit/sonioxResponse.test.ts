/**
 * Tests for the Soniox transcript mapper: what the sub-word tokens become
 * as words, how the flat token list is cut into segments (at a sentence end
 * and at a change of speaker), how Korean word spacing and scripts written
 * without spaces survive, and the shapes it degrades on rather than throws.
 */

import { mapSonioxTranscript } from 'src/transcription/providers/sonioxResponse';
import { at } from '../helpers/assertions';

/** One token as Soniox reports it, timed in milliseconds. */
function token(
	text: string,
	startMs: number,
	endMs: number,
	extra: { speaker?: string | null; language?: string } = {},
): Record<string, unknown> {
	return {
		text,
		start_ms: startMs,
		end_ms: endMs,
		confidence: 0.99,
		...extra,
	};
}

const PLAIN = { diarize: false };
const DIARIZED = { diarize: true };

describe('mapSonioxTranscript', () => {
	describe('a body with nothing to map', () => {
		it.each([
			{ name: 'null', body: null },
			{ name: 'a string', body: 'nope' },
			{ name: 'an array', body: [] },
		])('maps $name to no segments', ({ body }) => {
			expect(mapSonioxTranscript(body, PLAIN)).toEqual({ segments: [] });
		});

		it('maps an empty token list with no text to no segments', () => {
			expect(
				mapSonioxTranscript({ text: '', tokens: [] }, PLAIN).segments,
			).toEqual([]);
		});

		it('falls back to the flat text when the response carries no tokens', () => {
			expect(
				mapSonioxTranscript({ text: '  Hello there.  ' }, PLAIN)
					.segments,
			).toEqual([{ start: 0, end: 0, text: 'Hello there.' }]);
		});

		it('skips entries that are not tokens', () => {
			const result = mapSonioxTranscript(
				{
					tokens: [null, 'x', { start_ms: 1 }, token('Hi', 0, 100)],
				},
				PLAIN,
			);

			expect(result.segments).toEqual([
				{
					start: 0,
					end: 0.1,
					text: 'Hi',
					words: [{ text: 'Hi', start: 0, end: 0.1 }],
				},
			]);
		});
	});

	describe('Korean, whose tokens are syllables and whose words start with a space', () => {
		const tokens = [
			token('안', 210, 270),
			token('녕', 330, 390),
			token('하', 510, 570),
			token('세', 570, 630),
			token('요', 690, 750),
			token('.', 750, 770),
			token(' 오', 1200, 1260),
			token('늘', 1260, 1320),
			token(' 회', 1400, 1460),
			token('의', 1460, 1520),
			token('에서는', 1520, 1700),
		];

		it('joins the syllables of a word and splits words at the leading space', () => {
			const [first] = mapSonioxTranscript({ tokens }, PLAIN).segments;

			expect(first?.text).toBe('안녕하세요.');
			expect(first?.words).toEqual([
				{ text: '안녕하세요.', start: 0.21, end: 0.77 },
			]);
		});

		it('keeps the spaces Soniox wrote in the segment text', () => {
			const { segments } = mapSonioxTranscript({ tokens }, PLAIN);

			expect(at(segments, 1).text).toBe('오늘 회의에서는');
			expect(at(segments, 1).words?.map((word) => word.text)).toEqual([
				'오늘',
				'회의에서는',
			]);
		});

		it('times a segment from its first token to its last', () => {
			const { segments } = mapSonioxTranscript({ tokens }, PLAIN);

			expect(at(segments, 1).start).toBe(1.2);
			expect(at(segments, 1).end).toBe(1.7);
		});

		it('treats a token that is only a space as a word boundary with no word', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token(' 이', 0, 50),
						token('스', 50, 100),
						token(' ', 100, 120),
						token('녹', 120, 170),
						token('음', 170, 220),
						token('.', 220, 240),
					],
				},
				PLAIN,
			);

			expect(at(segments, 0).text).toBe('이스 녹음.');
			expect(at(segments, 0).words?.map((word) => word.text)).toEqual([
				'이스',
				'녹음.',
			]);
		});

		it('starts a word after a token that ends with a space', () => {
			const { segments } = mapSonioxTranscript(
				{ tokens: [token('가 ', 0, 50), token('나', 50, 100)] },
				PLAIN,
			);

			expect(at(segments, 0).words?.map((word) => word.text)).toEqual([
				'가',
				'나',
			]);
		});
	});

	describe('cutting segments at the end of a sentence', () => {
		it('ends a segment at a terminator followed by a new word', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token('습', 0, 50),
						token('니', 50, 100),
						token('다.', 100, 150),
						token(' 다음', 200, 300),
						token(' 주', 300, 350),
					],
				},
				PLAIN,
			);

			expect(segments.map((segment) => segment.text)).toEqual([
				'습니다.',
				'다음 주',
			]);
		});

		it.each(['.', '?', '!', '\u2026', '?"'])(
			'treats %s as the end of a sentence',
			(ender) => {
				const { segments } = mapSonioxTranscript(
					{
						tokens: [
							token(`a${ender}`, 0, 50),
							token(' b', 60, 100),
						],
					},
					PLAIN,
				);

				expect(segments).toHaveLength(2);
			},
		);

		it('does not end a sentence at a terminator inside a word', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token(' 3', 0, 50),
						token('.', 50, 60),
						token('5', 60, 100),
						token('배', 100, 150),
					],
				},
				PLAIN,
			);

			expect(segments).toHaveLength(1);
			expect(at(segments, 0).text).toBe('3.5배');
		});

		it('ends a sentence at a full-width terminator that no space follows', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token('こんにちは', 0, 500),
						token('。', 500, 520),
						token('元気', 600, 800),
						token('です', 800, 900),
						token('。', 900, 920),
					],
				},
				PLAIN,
			);

			expect(segments.map((segment) => segment.text)).toEqual([
				'こんにちは。',
				'元気です。',
			]);
		});

		it('keeps the spacing of a script written without spaces', () => {
			const { segments } = mapSonioxTranscript(
				{ tokens: [token('你', 0, 50), token('好', 50, 100)] },
				PLAIN,
			);

			expect(at(segments, 0).text).toBe('你好');
		});

		it('keeps an unterminated tail as a final segment', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token('Done.', 0, 50),
						token(' And', 60, 100),
						token(' more', 100, 150),
					],
				},
				PLAIN,
			);

			expect(segments.map((segment) => segment.text)).toEqual([
				'Done.',
				'And more',
			]);
		});
	});

	describe('speaker turns', () => {
		const tokens = [
			token('Hi', 0, 100, { speaker: '1' }),
			token(' there', 100, 200, { speaker: '1' }),
			token(' how', 300, 400, { speaker: '2' }),
			token(' are', 400, 500, { speaker: '2' }),
			token(' you.', 500, 600, { speaker: '2' }),
			token(' Fine', 700, 800, { speaker: '1' }),
			token('.', 800, 820, { speaker: '1' }),
		];

		it('starts a segment at each change of speaker and labels it', () => {
			const { segments } = mapSonioxTranscript({ tokens }, DIARIZED);

			expect(
				segments.map((segment) => [segment.speaker, segment.text]),
			).toEqual([
				['Speaker 1', 'Hi there'],
				['Speaker 2', 'how are you.'],
				['Speaker 1', 'Fine.'],
			]);
		});

		it('ends the turn at its sentence end when the same speaker goes on', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token('One.', 0, 100, { speaker: '1' }),
						token(' Two.', 100, 200, { speaker: '1' }),
					],
				},
				DIARIZED,
			);

			expect(segments.map((segment) => segment.speaker)).toEqual([
				'Speaker 1',
				'Speaker 1',
			]);
		});

		it('carries no speaker and no split when diarization was not asked for', () => {
			const { segments } = mapSonioxTranscript({ tokens }, PLAIN);

			expect(segments.map((segment) => segment.text)).toEqual([
				'Hi there how are you.',
				'Fine.',
			]);
			expect(segments.every((segment) => !('speaker' in segment))).toBe(
				true,
			);
		});

		it('keeps an unlabelled token with the speaker before it', () => {
			const { segments } = mapSonioxTranscript(
				{
					tokens: [
						token('Hi', 0, 100, { speaker: '1' }),
						token(' you', 100, 200, { speaker: null }),
					],
				},
				DIARIZED,
			);

			expect(segments).toHaveLength(1);
			expect(at(segments, 0).speaker).toBe('Speaker 1');
		});

		it('reads a numeric speaker the same as a string one', () => {
			const { segments } = mapSonioxTranscript(
				{ tokens: [{ ...token('Hi', 0, 100), speaker: 3 }] },
				DIARIZED,
			);

			expect(at(segments, 0).speaker).toBe('Speaker 3');
		});
	});

	describe('the language and the usage', () => {
		it('reports the language most of the text is in, by characters', () => {
			const result = mapSonioxTranscript(
				{
					tokens: [
						token('좋아요', 0, 100, { language: 'ko' }),
						token(' ok', 100, 200, { language: 'en' }),
						token(' 회의를', 200, 300, { language: 'ko' }),
					],
				},
				PLAIN,
			);

			expect(result.language).toBe('ko');
		});

		it('leaves the language unset when no token names one', () => {
			expect(
				mapSonioxTranscript({ tokens: [token('Hi', 0, 100)] }, PLAIN)
					.language,
			).toBeUndefined();
		});

		it('converts the reported audio length to billed seconds', () => {
			expect(
				mapSonioxTranscript(
					{ tokens: [token('Hi', 0, 100)] },
					{ diarize: false, audioDurationMs: 13320 },
				).usage,
			).toEqual({ audioSeconds: 13.32 });
		});

		it.each([undefined, -1, Number.NaN])(
			'reports no usage for an audio length of %s',
			(audioDurationMs) => {
				expect(
					mapSonioxTranscript(
						{ tokens: [token('Hi', 0, 100)] },
						{ diarize: false, audioDurationMs },
					),
				).not.toHaveProperty('usage');
			},
		);
	});
});
