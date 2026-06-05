import { writable } from 'svelte/store';

export type AudioMode = 'auto' | 'native';

function createAudioMode() {
  const initial: AudioMode =
    typeof localStorage !== 'undefined'
      ? ((localStorage.getItem('audioMode') as AudioMode) ?? 'auto')
      : 'auto';

  const { subscribe, set } = writable<AudioMode>(initial);

  return {
    subscribe,
    set(value: AudioMode) {
      if (typeof localStorage !== 'undefined') localStorage.setItem('audioMode', value);
      set(value);
    },
  };
}

export const audioMode = createAudioMode();
