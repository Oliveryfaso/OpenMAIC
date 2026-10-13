import { liveQuery } from 'dexie';
import { resolveLegacySpeechAudioId } from '@/lib/audio/regenerate-speech-tts';
import type { Scene } from '@/lib/types/stage';

/** Observe only device-cache evidence; course data remains in the document store. */
export function observeLegacySpeechAudio(
  scene: Pick<Scene, 'actions' | 'order'>,
  next: (actionIds: Set<string>) => void,
  error: () => void,
): () => void {
  const subscription = liveQuery(async () => {
    const audio = new Set<string>();
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && (await resolveLegacySpeechAudioId(scene.order, action))) {
        audio.add(action.id);
      }
    }
    return audio;
  }).subscribe({ next, error });
  return () => subscription.unsubscribe();
}
