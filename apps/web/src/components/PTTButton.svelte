<script lang="ts">
  import { pttState, isInChannel, busyCallsign, speakerCallsign } from '$lib/stores/channel.js';
  import { onPTTDown, onPTTUp, onPTTCancel } from '$lib/ptt.js';
  import { pttKey, savePttKey, pttKeyLabel } from '$lib/stores/pttKey.js';
  import Waveform from './Waveform.svelte';

  let assigningKey = false;

  function startKeyAssign() {
    assigningKey = true;
  }

  function captureKey(e: KeyboardEvent) {
    if (!assigningKey) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      assigningKey = false;
      return;
    }
    savePttKey(e.key);
    assigningKey = false;
    (e.target as HTMLInputElement)?.blur();
  }

  $: isTransmitting = $pttState === 'transmitting';
  $: isBusy = $pttState === 'busy';
  $: disabled = !$isInChannel || isBusy;
</script>

<div class="flex flex-col items-center gap-4">
  <!-- Speaker indicator (others transmitting) -->
  {#if $speakerCallsign}
    <div class="flex flex-col items-center gap-2 py-2">
      <span class="text-xs font-mono text-slate-400 uppercase tracking-widest">ON AIR</span>
      <span class="text-mint font-mono text-lg tracking-wider">{$speakerCallsign}</span>
      <Waveform active={true} />
    </div>
  {/if}

  <!-- Channel busy indicator -->
  {#if isBusy}
    <div class="text-center">
      <p class="text-amber-400 font-mono text-sm">CHANNEL SIBUK</p>
      <p class="text-slate-500 text-xs font-mono">{$busyCallsign} sedang transmit</p>
    </div>
  {/if}

  <!-- PTT Button -->
  <button
    class="
      relative w-40 h-40 rounded-full font-mono text-sm uppercase tracking-widest
      border-2 transition-all duration-150 select-none touch-none
      {isTransmitting
        ? 'bg-mint/20 border-mint text-mint animate-pulse-glow'
        : isBusy
          ? 'bg-amber-400/10 border-amber-400 text-amber-400 cursor-not-allowed'
          : !$isInChannel
            ? 'bg-space-800 border-slate-700 text-slate-600 cursor-not-allowed'
            : 'bg-space-800 border-slate-600 text-slate-300 hover:border-mint/50 hover:text-mint active:scale-95'}
    "
    {disabled}
    on:pointerdown={onPTTDown}
    on:pointerup={onPTTUp}
    on:pointercancel={onPTTCancel}
    on:contextmenu|preventDefault
  >
    <div class="flex flex-col items-center gap-2">
      <!-- Mic icon -->
      <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        {#if isBusy}
          <!-- Blocked icon -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        {:else}
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
        {/if}
      </svg>

      <span class="text-center leading-tight">
        {#if isTransmitting}
          TRANSMIT
        {:else if isBusy}
          SIBUK
        {:else if !$isInChannel}
          MASUK<br>DULU
        {:else}
          TAHAN<br>BICARA
        {/if}
      </span>
    </div>

    <!-- Transmitting pulse ring -->
    {#if isTransmitting}
      <span class="absolute inset-0 rounded-full border-2 border-mint animate-ping opacity-30"></span>
    {/if}
  </button>

  {#if $isInChannel && !isTransmitting && !isBusy && !$speakerCallsign}
    <p class="text-slate-600 text-xs font-mono text-center">
      Tahan tombol untuk bicara
    </p>

    <!-- Keyboard shortcut assignment (desktop only) -->
    <div class="hidden sm:flex items-center gap-2">
      <span class="text-slate-700 text-xs font-mono">Key:</span>
      {#if assigningKey}
        <!-- Hidden input that captures the next keydown -->
        <input
          type="text"
          readonly
          placeholder="tekan tombol..."
          autofocus
          on:keydown={captureKey}
          on:blur={() => (assigningKey = false)}
          class="w-28 text-center text-xs font-mono bg-space-800 border border-amber-400/50 text-amber-400 rounded px-2 py-0.5 outline-none placeholder-amber-400/60 animate-pulse"
        />
      {:else}
        <button
          class="text-slate-500 text-xs font-mono border border-slate-700 px-1.5 py-0.5 rounded hover:border-mint/50 hover:text-mint transition-colors"
          on:click={startKeyAssign}
          title="Klik untuk ganti tombol PTT"
        >
          {pttKeyLabel($pttKey)}
        </button>
      {/if}
    </div>
  {/if}
</div>
