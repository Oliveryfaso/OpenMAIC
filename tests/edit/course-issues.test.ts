// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { db } from '@/lib/device-storage/database';
import { useSceneIssues } from '@/lib/edit/use-scene-issues';
import type { Scene } from '@/lib/types/stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
const scene = (audioId?: string): Scene =>
  ({
    id: 's',
    stageId: 'c',
    type: 'slide',
    title: 'S',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
        elements: [],
      },
    },
    actions: [{ id: 'a', type: 'speech', text: 'Hello', audioId }],
  }) as Scene;
function Probe({ scene }: { scene: Scene }) {
  return createElement(
    'div',
    null,
    useSceneIssues(scene)
      .map((i) => i.kind)
      .join(','),
  );
}
afterEach(async () => {
  await act(async () => root.render(null));
  await db.audioFiles.clear();
});
it('updates from current document and live legacy audio writes/deletes', async () => {
  const s = scene();
  await act(async () => root.render(createElement(Probe, { scene: s })));
  expect(host.textContent).toContain('speech-without-audio');
  await act(async () => {
    await db.audioFiles.put({
      id: 'tts_s1_a',
      blob: new Blob(['audio']),
      createdAt: Date.now(),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.textContent).toBe('');
  await act(async () => {
    await db.audioFiles.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.textContent).toContain('speech-without-audio');
  await act(async () => root.render(createElement(Probe, { scene: scene('allocated-audio') })));
  expect(host.textContent).toBe('');
});
