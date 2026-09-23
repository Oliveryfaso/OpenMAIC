import { describe, expect, it } from 'vitest';
import {
  createParserState,
  finalizeParser,
  parseStructuredChunk,
  stripProviderToolMarkup,
} from '@/lib/orchestration/stateless-generate';

// Shape observed in a classroom answer: DSML tool-call markup emitted as plain
// text by a Legacy child that has no native tools registered.
const DSML_WB_CLEAR = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="action">',
  '<｜｜DSML｜｜ parameter name="name" string="true">wb_clear</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="params" string="false">{}</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n');

function parseChunks(chunks: string[]) {
  const state = createParserState();
  const results = chunks.map((chunk) => parseStructuredChunk(chunk, state));
  results.push(finalizeParser(state));
  return {
    state,
    text: results.flatMap((result) => result.textChunks).join(''),
    actions: results.flatMap((result) => result.actions),
  };
}

describe('Legacy structured parser: provider tool-call markup', () => {
  it('shows nothing and executes nothing for markup-only output', () => {
    const { state, text, actions } = parseChunks([DSML_WB_CLEAR]);

    expect(text).toBe('');
    expect(actions).toEqual([]);
    expect(state.providerMarkupSuppressed).toBe(true);
  });

  it('keeps the prose before the markup and drops the markup', () => {
    const prose = '好的，我们换一道新题。';
    const { text, actions } = parseChunks([`${prose}\n\n${DSML_WB_CLEAR}`]);

    expect(text).toBe(prose);
    expect(actions).toEqual([]);
  });

  it.each([
    ['single bars', '<｜DSML｜function_calls>\n<｜DSML｜invoke name="wb_clear">'],
    ['repeated bars with spaces', '< ｜｜ DSML ｜｜ calls>'],
    ['ASCII bars', '<|DSML|invoke name="action">'],
    ['closing tag first', '</｜DSML｜parameter>'],
  ])('recognizes the %s variant', (_label, markup) => {
    const { state, text } = parseChunks([`讲解如下。${markup}`]);

    expect(text).toBe('讲解如下。');
    expect(state.providerMarkupSuppressed).toBe(true);
  });

  it('recognizes markup split across stream chunks', () => {
    const { text, actions } = parseChunks([
      '我来清空白板。<',
      '｜｜DS',
      'ML｜｜ invoke name="action">wb_clear',
    ]);

    expect(text).toBe('我来清空白板。');
    expect(actions).toEqual([]);
  });

  it('never parses JSON found inside markup parameters as actions', () => {
    const params = '{"items":[{"type":"action","name":"wb_clear","params":{}}]}';
    const { state, text, actions } = parseChunks([
      `先看题目。<｜DSML｜parameter name="params" string="false">${params}</｜DSML｜parameter>`,
    ]);

    expect(text).toBe('先看题目。');
    expect(actions).toEqual([]);
    expect(state.jsonStarted).toBe(false);
  });

  it('leaves ordinary structured JSON actions and text unchanged', () => {
    const output = JSON.stringify([
      { type: 'action', name: 'wb_open', params: {} },
      { type: 'text', content: '当 a < b 时，结论成立。' },
    ]);
    const splitAt = output.indexOf('<') + 1;
    const { state, text, actions } = parseChunks([output.slice(0, splitAt), output.slice(splitAt)]);

    expect(actions).toEqual([expect.objectContaining({ actionName: 'wb_open', params: {} })]);
    expect(text).toBe('当 a < b 时，结论成立。');
    expect(state.providerMarkupSuppressed).toBe(false);
  });

  it.each([
    'DSML 是一种工具调用标记格式，我们今天不讨论它。',
    '写作 <DSML> 的标签不是厂商标记。',
    '所以 x 小于 y 写作 x <',
  ])('keeps prose that merely mentions DSML or ends with "<": %s', (prose) => {
    const { state, text } = parseChunks([prose]);

    expect(text).toBe(prose);
    expect(state.providerMarkupSuppressed).toBe(false);
  });

  it('strips from the first markup token in non-streamed text', () => {
    expect(stripProviderToolMarkup(`前文。${DSML_WB_CLEAR}`)).toBe('前文。');
    expect(stripProviderToolMarkup('没有标记的文字')).toBe('没有标记的文字');
  });
});
