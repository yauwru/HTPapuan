<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    currentFrequency,
    currentCallsign,
    connectionState,
    isConnected,
    isInChannel,
    members,
    speakerCallsign,
    pttState,
    textMessages,
  } from '$lib/stores/channel.js';
  import { connect, disconnect, joinChannel, leaveChannel } from '$lib/wsClient.js';
  import { initWebRTC, cleanup as cleanupWebRTC } from '$lib/webrtc.js';
  import { playSquelchOpen } from '$lib/audio/squelch.js';
  import { audioBuffering } from '$lib/audio/relay.js';
  import SignalMeter from '$components/SignalMeter.svelte';
  import MemberList from '$components/MemberList.svelte';
  import PTTButton from '$components/PTTButton.svelte';

  let freqInput = '';
  let callsignInput = '';
  let textInput = '';
  let joinError = '';

  // Persist callsign across sessions
  onMount(() => {
    callsignInput = localStorage.getItem('callsign') ?? '';
    freqInput = localStorage.getItem('lastFrequency') ?? '';
    initWebRTC(null); // Setup WebRTC signaling handlers early
    connect();
  });

  onDestroy(() => {
    cleanupWebRTC();
    disconnect();
  });

  // Play squelch when someone joins
  let prevMemberCount = 0;
  $: if ($members.length > prevMemberCount) {
    prevMemberCount = $members.length;
    if ($isInChannel) playSquelchOpen();
  } else {
    prevMemberCount = $members.length;
  }

  async function handleJoin(): Promise<void> {
    joinError = '';

    const freq = freqInput.replace(/[^A-Z0-9._\-]/gi, '').toUpperCase().trim();
    const callsign = callsignInput.replace(/[^A-Z0-9\-_ ]/gi, '').trim().toUpperCase();

    if (!freq) { joinError = 'Masukkan kode frekuensi'; return; }
    if (!callsign) { joinError = 'Masukkan callsign / nama panggilanmu'; return; }
    if (callsign.length < 2) { joinError = 'Callsign minimal 2 karakter'; return; }

    localStorage.setItem('callsign', callsignInput);
    localStorage.setItem('lastFrequency', freq);

    if (!$isConnected) {
      joinError = 'Belum terhubung ke server. Coba lagi...';
      return;
    }

    joinChannel(freq, callsign);
  }

  function handleLeave(): void {
    leaveChannel();
    freqInput = $currentFrequency ?? freqInput;
  }

  function sendText(): void {
    const text = textInput.trim();
    if (!text || !$isInChannel) return;
    import('$lib/wsClient.js').then((m) => m.send({ type: 'text_broadcast', text }));
    textInput = '';
  }

  function handleTextKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  }
</script>

<svelte:head>
  <title>Starry Glade Radio</title>
</svelte:head>

<div class="relative z-10 min-h-screen flex flex-col items-center justify-start px-4 py-6 gap-6 max-w-md mx-auto">
  <!-- Header -->
  <header class="w-full flex items-center justify-between">
    <div>
      <h1 class="font-mono text-lg text-slate-200 tracking-widest">✦ STARRY GLADE</h1>
      <p class="font-mono text-xs text-slate-500 tracking-widest">RADIO</p>
    </div>
    <SignalMeter />
  </header>

  {#if !$isInChannel}
    <!-- ========== JOIN SCREEN ========== -->
    <div class="w-full space-y-6">

      <!-- Frequency display -->
      <div class="bg-space-800 border border-slate-700/50 rounded-2xl p-5">
        <label for="freq-input" class="block text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">
          Kode Frekuensi
        </label>
        <input
          id="freq-input"
          bind:value={freqInput}
          type="text"
          inputmode="text"
          maxlength="12"
          placeholder="contoh: 147300"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          class="
            lcd w-full bg-transparent text-3xl text-amber-400 placeholder-slate-700
            border-none outline-none tracking-widest
          "
          on:keydown={(e) => e.key === 'Enter' && handleJoin()}
        />
        <div class="mt-2 h-px bg-amber-400/30"></div>
        <p class="mt-2 text-xs text-slate-600 font-mono">
          Sepakati kode yang sama dengan teman-temanmu
        </p>
      </div>

      <!-- Callsign input -->
      <div class="bg-space-800 border border-slate-700/50 rounded-2xl p-5">
        <label for="callsign-input" class="block text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">
          Callsign / Nama Panggilanmu
        </label>
        <input
          id="callsign-input"
          bind:value={callsignInput}
          type="text"
          inputmode="text"
          maxlength="12"
          placeholder="contoh: DELTA-9"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          class="
            lcd w-full bg-transparent text-2xl text-slate-200 placeholder-slate-700
            border-none outline-none tracking-widest uppercase
          "
          on:keydown={(e) => e.key === 'Enter' && handleJoin()}
        />
        <div class="mt-2 h-px bg-slate-600/30"></div>
      </div>

      {#if joinError}
        <p class="text-red-400 text-sm font-mono text-center">{joinError}</p>
      {/if}

      <!-- Join button -->
      <button
        on:click={handleJoin}
        disabled={$connectionState === 'connecting'}
        class="
          w-full py-4 rounded-2xl font-mono uppercase tracking-widest text-sm
          transition-all duration-200
          {$connectionState === 'connecting'
            ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
            : 'bg-mint/20 border border-mint/50 text-mint hover:bg-mint/30 active:scale-98'}
        "
      >
        {$connectionState === 'connecting' ? 'Menghubungkan...' : 'Masuk Channel →'}
      </button>

      <!-- Connection status -->
      {#if $connectionState === 'reconnecting'}
        <p class="text-center text-amber-400 text-xs font-mono animate-pulse">
          Mencoba menyambung kembali...
        </p>
      {/if}
    </div>

  {:else}
    <!-- ========== CHANNEL SCREEN ========== -->

    <!-- Frequency display -->
    <div class="w-full bg-space-800 border border-slate-700/50 rounded-2xl p-4">
      <p class="text-xs font-mono text-slate-500 uppercase tracking-widest">Frekuensi</p>
      <p class="lcd text-3xl text-amber-400 tracking-widest mt-1">{$currentFrequency}</p>
      <div class="flex items-center justify-between mt-1">
        <p class="text-xs font-mono text-slate-500">{$members.length} anggota aktif</p>
        {#if $speakerCallsign && $audioBuffering}
          <span class="text-xs font-mono text-amber-400 animate-pulse">BUFFERING...</span>
        {/if}
      </div>
    </div>

    <!-- Member list -->
    <div class="w-full">
      <MemberList />
    </div>

    <!-- PTT Button (center of screen) -->
    <div class="w-full flex justify-center py-4">
      <PTTButton />
    </div>

    <!-- Text messages (compact, Phase 2) -->
    {#if $textMessages.length > 0}
      <div class="w-full bg-space-800 rounded-xl p-3 max-h-24 overflow-y-auto space-y-1">
        {#each $textMessages as msg (msg.timestamp)}
          <p class="font-mono text-xs text-slate-300">
            <span class="text-mint">{msg.callsign}:</span>
            {msg.text}
          </p>
        {/each}
      </div>
    {/if}

    <!-- Text input -->
    <div class="w-full flex gap-2">
      <input
        bind:value={textInput}
        type="text"
        maxlength="80"
        placeholder="Kirim pesan teks..."
        class="flex-1 bg-space-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-mint/50"
        on:keydown={handleTextKey}
        disabled={!$isInChannel}
      />
      <button
        on:click={sendText}
        disabled={!textInput.trim() || !$isInChannel}
        class="px-3 py-2 rounded-xl bg-mint/20 border border-mint/30 text-mint font-mono text-sm disabled:opacity-30"
      >
        →
      </button>
    </div>

    <!-- Leave button -->
    <button
      on:click={handleLeave}
      class="w-full py-3 rounded-xl font-mono text-sm uppercase tracking-widest text-slate-500 border border-slate-700/50 hover:border-red-400/30 hover:text-red-400 transition-colors"
    >
      Keluar Channel
    </button>
  {/if}

  <!-- Footer -->
  <footer class="mt-auto pt-4 text-center">
    <p class="text-slate-700 text-xs font-mono">Starry Glade Radio · v0.1.0</p>
  </footer>
</div>
