import { describe, expect, it, vi } from 'vitest';
import { buildReadSceneTool } from '@/lib/chat/pi/tools/read-scene';
import type { StatelessChatRequest } from '@/lib/types/chat';

function makeBody(): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Photosynthesis',
        createdAt: 1,
        updatedAt: 50,
      },
      outlines: [
        {
          id: 'outline-2',
          type: 'slide',
          title: 'Light reactions',
          description: 'How light energy becomes chemical energy.',
          keyPoints: ['chlorophyll absorbs light', 'ATP and NADPH are produced'],
          order: 2,
        },
      ],
      scenes: [
        {
          id: 'scene-2',
          outlineId: 'outline-2',
          stageId: 'stage-1',
          title: 'Light reactions',
          order: 2,
          type: 'slide',
          updatedAt: 42,
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'equation',
                  type: 'text',
                  content: 'Light energy drives ATP production',
                  left: 40,
                  top: 60,
                  width: 400,
                  height: 80,
                },
              ],
            } as never,
          },
        },
      ],
      currentSceneId: 'scene-2',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: { agentIds: ['teacher'] },
    apiKey: '',
  } as StatelessChatRequest;
}

function makeInteractiveBody(html: string): StatelessChatRequest {
  const body = makeBody();
  body.storeState.outlines = [
    {
      id: 'outline-game',
      type: 'interactive',
      title: 'Word sorting',
      description: 'Sort each word into the correct category.',
      keyPoints: ['A new word appears every 3 seconds', 'Unsorted words leave after 12 seconds'],
      order: 1,
    },
  ];
  body.storeState.scenes = [
    {
      id: 'scene-game',
      outlineId: 'outline-game',
      stageId: 'stage-1',
      title: 'Word sorting',
      order: 1,
      type: 'interactive',
      updatedAt: 51,
      content: { type: 'interactive', widgetType: 'game', html },
    },
  ];
  body.storeState.currentSceneId = 'scene-game';
  return body;
}

describe('Pi Director read_scene', () => {
  it('reads an exact scene id and returns evidence with provenance', async () => {
    const onEvidence = vi.fn();
    const tool = buildReadSceneTool({ body: makeBody(), onEvidence });

    const result = await tool.execute('read-1', { sceneId: 'scene-2' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(text).toContain('sceneId=scene-2');
    expect(text).toContain('revision=42');
    expect(text).toContain('source=request_start_snapshot');
    expect(text).toContain('ATP and NADPH are produced');
    expect(text).toContain('[id:equation]');
    expect(text).toContain('Light energy drives ATP production');
    expect(result.details).toMatchObject({
      status: 'ok',
      sceneId: 'scene-2',
      revision: '42',
      source: 'request_start_snapshot',
      truncated: false,
    });
    expect(onEvidence).toHaveBeenCalledOnce();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('sceneId=scene-2'),
        details: expect.objectContaining({
          status: 'ok',
          sceneId: 'scene-2',
          revision: '42',
          source: 'request_start_snapshot',
        }),
      }),
    );
  });

  it('rejects an unknown id instead of falling back to the current scene', async () => {
    const onEvidence = vi.fn();
    const tool = buildReadSceneTool({ body: makeBody(), onEvidence });

    const result = await tool.execute('read-2', { sceneId: 'missing-scene' });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'not_found', sceneId: 'missing-scene' });
    expect(onEvidence).not.toHaveBeenCalled();
  });

  it('uses stable outlineId rather than mutable order after scenes are reordered', async () => {
    const body = makeBody();
    body.storeState.outlines = [
      {
        id: 'outline-2',
        type: 'slide',
        title: 'Light reactions',
        description: 'CORRECT_OUTLINE_DESCRIPTION',
        keyPoints: ['CORRECT_OUTLINE_KEY'],
        order: 2,
      },
      {
        id: 'outline-other',
        type: 'slide',
        title: 'Other scene',
        description: 'WRONG_ORDER_DESCRIPTION',
        keyPoints: ['WRONG_ORDER_KEY'],
        order: 9,
      },
    ];
    body.storeState.scenes[0].order = 9;
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-reordered', { sceneId: 'scene-2' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('CORRECT_OUTLINE_DESCRIPTION');
    expect(text).toContain('CORRECT_OUTLINE_KEY');
    expect(text).not.toContain('WRONG_ORDER_DESCRIPTION');
    expect(text).not.toContain('WRONG_ORDER_KEY');
  });

  it('does not expose canonical quiz answers before submission', async () => {
    const body = makeBody();
    body.storeState.scenes = [
      {
        id: 'quiz-1',
        stageId: 'stage-1',
        title: 'Checkpoint',
        order: 3,
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              type: 'single',
              question: 'Where do light reactions occur?',
              options: [
                { value: 'A', label: 'Nucleus' },
                { value: 'B', label: 'Thylakoid membrane' },
              ],
              answer: ['B'],
            },
          ],
        },
      },
    ] as never;
    body.storeState.currentSceneId = 'quiz-1';
    body.storeState.outlines = [];
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-3', { sceneId: 'quiz-1' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('Where do light reactions occur?');
    expect(text).toContain('Strict rules while the quiz is unsubmitted');
    expect(text).not.toContain('Correct answer:');
  });

  it('withholds PBL payloads in v1 instead of leaking hidden project configuration', async () => {
    const body = makeBody();
    body.storeState.scenes = [
      {
        id: 'pbl-1',
        stageId: 'stage-1',
        title: 'Design challenge',
        order: 4,
        type: 'pbl',
        content: {
          type: 'pbl',
          projectConfig: { hiddenTeacherSolution: 'SECRET_SOLUTION' },
        },
      },
    ] as never;
    body.storeState.currentSceneId = 'pbl-1';
    body.storeState.outlines = [];
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-4', { sceneId: 'pbl-1' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('pbl payload is not exposed by read_scene v1');
    expect(text).not.toContain('SECRET_SOLUTION');
  });

  it('reads source-authored Interactive instructions without executing or exposing scripts and styles', async () => {
    const body = makeInteractiveBody(`<!doctype html><html><head>
      <style>.start-screen { display: none } STYLE_SECRET</style>
    </head><body>
      <section class="start-screen">
        <p>Each word rolls away after 12 seconds — that costs a life.</p>
        <p>Wrong box → −5 points, the word comes back.</p>
      </section>
      <output>Lives: 3</output>
      <script>window.currentScore = 999; SCRIPT_SECRET</script>
    </body></html>`);
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-game', { sceneId: 'scene-game' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(result.details).toMatchObject({ status: 'ok', sceneId: 'scene-game' });
    expect(text).toContain('课件源码中的静态说明');
    expect(text).toContain('Each word rolls away after 12 seconds — that costs a life.');
    expect(text).toContain('Wrong box → −5 points, the word comes back.');
    expect(text).toContain('Lives: 3');
    expect(text).toContain('authored default or placeholder values');
    expect(text).toContain('does not prove what is currently visible, selected, or happening');
    expect(text).not.toContain('STYLE_SECRET');
    expect(text).not.toContain('SCRIPT_SECRET');
    expect(text).not.toContain('window.currentScore');
    expect(text).not.toContain('<script');
  });

  it('retains a source-authored rule written directly under body', async () => {
    const body = makeInteractiveBody(`<!doctype html><html><body>
      Wrong box: lose 5 points.<button>Start</button>
      <script>DIRECT_SCRIPT_SECRET</script>
    </body></html>`);
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-direct-body-text', { sceneId: 'scene-game' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(result.details).toMatchObject({ status: 'ok', sceneId: 'scene-game' });
    expect(text).toContain('Wrong box: lose 5 points.');
    expect(text).toContain('Start');
    expect(text).not.toContain('DIRECT_SCRIPT_SECRET');
  });

  it('keeps the existing fail-without-truncation scene evidence budget', async () => {
    const onEvidence = vi.fn();
    const body = makeInteractiveBody(
      `<!doctype html><html><body><main>${'A'.repeat(25_000)}</main></body></html>`,
    );
    const tool = buildReadSceneTool({ body, onEvidence });

    const result = await tool.execute('read-large-game', { sceneId: 'scene-game' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'too_large', truncated: false });
    expect(text).toContain('too large for read_scene v1');
    expect(text).toContain('not silently truncated');
    expect(text).not.toContain('AAAA');
    expect(onEvidence).not.toHaveBeenCalled();
  });
});
