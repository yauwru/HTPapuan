import { writable } from 'svelte/store';

export const pttKey = writable<string>(' ');

export function initPttKey(): void {
  if (typeof localStorage === 'undefined') return;
  const stored = localStorage.getItem('pttKey');
  if (stored !== null) pttKey.set(stored);
}

export function savePttKey(key: string): void {
  pttKey.set(key);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('pttKey', key);
  }
}

export function pttKeyLabel(key: string): string {
  if (key === ' ') return 'SPACE';
  if (key === 'Enter') return 'ENTER';
  if (key === 'Tab') return 'TAB';
  if (key === 'Control') return 'CTRL';
  if (key === 'Shift') return 'SHIFT';
  if (key === 'Alt') return 'ALT';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key.length === 1) return key.toUpperCase();
  return key.toUpperCase();
}
