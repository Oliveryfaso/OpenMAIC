import { describe, expect, it } from 'vitest';
import { collectCourseIssues, type CourseIssueScene } from '../src/course-issues.js';
import type { Action } from '../src/action.js';
import type { Slide } from '../src/slides.js';
const scene = (actions: Action[], elements: Slide['elements'] = []): CourseIssueScene => ({
  id: 's',
  stageId: 'c',
  title: 'Scene',
  order: 0,
  content: { type: 'slide', canvas: { elements } as Slide },
  actions,
});
const speech = { id: 'a', type: 'speech', text: 'Hello' } as const;
const issues = (s: CourseIssueScene) => collectCourseIssues({ scenes: [s] });
describe('current course issues', () => {
  it('clears missing narration when audio is added without mutating the course', () => {
    const s = scene([speech]);
    const before = structuredClone(s);
    expect(issues(s)).toMatchObject([
      {
        kind: 'speech-without-audio',
        sceneId: 's',
        actionId: 'a',
        severity: 'warning',
        source: 'document',
      },
    ]);
    expect(s).toEqual(before);
    expect(issues(scene([{ ...speech, audioId: 'asset-1' }]))).toEqual([]);
  });
  it('keeps empty speech as lint only and preserves other lint kinds', () => {
    expect(issues(scene([])).map((i) => i.kind)).toEqual(['empty-actions']);
    const s = scene([
      { ...speech, text: '  ' },
      { id: 'b', type: 'laser', elementId: '' },
      { id: 'd', type: 'discussion', topic: '' } as Action,
    ]);
    expect(issues(s).map((i) => i.kind)).toEqual([
      'empty-speech',
      'unbound-cue',
      'empty-discussion',
    ]);
  });
  it('honors legacy audio evidence but not invalidated audio', () => {
    expect(
      issues(scene([{ ...speech, audioUrl: 'https://example.com/audio.mp3' } as Action])),
    ).toEqual([]);
    expect(
      collectCourseIssues({ scenes: [scene([speech])] }, { hasLegacyAudio: () => true }),
    ).toEqual([]);
    expect(
      collectCourseIssues(
        { scenes: [scene([{ ...speech, audioInvalidated: true }])] },
        { hasLegacyAudio: () => true },
      ),
    ).toMatchObject([{ kind: 'speech-without-audio' }]);
    expect(issues(scene([speech]))[0].detail).toMatch(/local audio/i);
  });
  it('clears dangling cues after rebinding', () => {
    const cue = { id: 'cue', type: 'spotlight', elementId: 'gone' } as const;
    const elements = [{ id: 'present', type: 'text' }] as Slide['elements'];
    expect(issues(scene([cue], elements))).toMatchObject([
      { kind: 'dangling-cue', elementId: 'gone', actionId: 'cue' },
    ]);
    expect(issues(scene([{ ...cue, elementId: 'present' }], elements))).toEqual([]);
  });
  it('detects placeholder slots and whiteboards, deduplicates video pairs and clears repaired media', () => {
    const s = scene([{ ...speech, audioId: 'audio' }], [
      { id: 'v', type: 'video', src: 'gen_vid_1', mediaRef: 'gen_vid_1' },
    ] as Slide['elements']);
    s.whiteboards = [{ elements: [{ id: 'img', type: 'image', src: 'gen_img_1' }] } as Slide];
    expect(issues(s)).toMatchObject([
      { kind: 'media-not-generated', elementId: 'v', severity: 'error' },
      { kind: 'media-not-generated', elementId: 'img' },
    ]);
    s.content = {
      type: 'slide',
      canvas: { elements: [{ id: 'v', type: 'video', src: 'real', mediaRef: 'real' }] } as Slide,
    };
    s.whiteboards = [];
    expect(issues(s)).toEqual([]);
  });
  it('does not mistake URLs containing placeholder text for placeholders', () => {
    expect(
      issues(
        scene([{ ...speech, audioId: 'audio' }], [
          { id: 'img', type: 'image', src: 'https://example.com/gen_img_1.png' },
        ] as Slide['elements']),
      ),
    ).toEqual([]);
  });
});

it('keeps scene identities separate and includes background placeholders', () => {
  const a = scene([{ ...speech, audioId: 'audio' }]);
  a.content = {
    type: 'slide',
    canvas: {
      elements: [],
      background: { type: 'image', image: { src: 'gen_img_bg' } },
    } as unknown as Slide,
  };
  const b = { ...scene([speech]), id: 'other' };
  expect(collectCourseIssues({ scenes: [a, b] })).toMatchObject([
    { sceneId: 's', kind: 'media-not-generated' },
    { sceneId: 'other', kind: 'speech-without-audio' },
  ]);
});

it('handles quiz and interactive scenes without assuming a canvas exists', () => {
  for (const type of ['quiz', 'interactive', 'pbl'] as const) {
    expect(issues({ ...scene([speech]), content: { type } })).toMatchObject([
      { kind: 'speech-without-audio' },
    ]);
  }
});

it('does not call browser evidence for valid or blank speech, and ignores stale legacy URLs', () => {
  expect(
    issues(
      scene([
        { ...speech, audioInvalidated: true, audioUrl: 'https://example.com/stale' } as Action,
      ]),
    ),
  ).toMatchObject([{ kind: 'speech-without-audio' }]);
  expect(
    collectCourseIssues(
      { scenes: [scene([{ ...speech, audioId: 'current' }])] },
      {
        hasLegacyAudio: () => {
          throw new Error('unexpected lookup');
        },
      },
    ),
  ).toEqual([]);
});

it('uses playable video source precedence rather than stale placeholder slots', () => {
  for (const video of [
    { src: 'https://example.com/video.mp4', mediaRef: 'gen_vid_old' },
    { src: 'gen_vid_old', mediaRef: 'allocated-video' },
  ]) {
    expect(
      issues(
        scene([{ ...speech, audioId: 'audio' }], [
          { id: 'v', type: 'video', ...video },
        ] as Slide['elements']),
      ),
    ).toEqual([]);
  }
});
it('reports a play_video cue bound to an element that is not a video', () => {
  expect(
    issues(
      scene([{ id: 'play', type: 'play_video', elementId: 'text' }], [
        { id: 'text', type: 'text' },
      ] as Slide['elements']),
    ),
  ).toMatchObject([{ kind: 'dangling-cue', actionId: 'play', elementId: 'text' }]);
});
