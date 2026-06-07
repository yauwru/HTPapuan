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
    visitLog,
    frequencyDirectory,
  } from '$lib/stores/channel.js';
  import { requestNotificationPermission } from '$lib/notifications.js';
  import { connect, disconnect, joinChannel, leaveChannel } from '$lib/wsClient.js';
  import { initWebRTC, cleanup as cleanupWebRTC } from '$lib/webrtc.js';
  import { playSquelchOpen } from '$lib/audio/squelch.js';
  import { audioBuffering, requestMicPermission } from '$lib/audio/relay.js';
  import { initPttKey } from '$lib/stores/pttKey.js';
  import SignalMeter from '$components/SignalMeter.svelte';
  import MemberList from '$components/MemberList.svelte';
  import PTTButton from '$components/PTTButton.svelte';

  import type { UserRole } from '$lib/stores/channel.js';

  let freqInput = '';
  let callsignInput = '';
  let role: UserRole = 'pilot';
  let textInput = '';
  let joinError = '';
  let utcClock = '';
  let clockTimer: ReturnType<typeof setInterval>;

  function updateClock() {
    const n = new Date();
    utcClock = `${String(n.getUTCHours()).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')}:${String(n.getUTCSeconds()).padStart(2,'0')}Z`;
  }

  function formatFreq(raw: string): string {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    if (digits.length <= 3) return digits;
    return digits.slice(0, 3) + '.' + digits.slice(3);
  }

  function handleFreqInput(e: Event): void {
    freqInput = formatFreq((e.target as HTMLInputElement).value);
  }

  onMount(() => {
    callsignInput = localStorage.getItem('callsign') ?? '';
    freqInput = formatFreq(localStorage.getItem('lastFrequency') ?? '');
    role = (localStorage.getItem('role') as UserRole) ?? 'pilot';
    initPttKey();
    initWebRTC(null);
    connect();
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
    // Request mic permission upfront so first PTT press is never blocked by dialog
    requestMicPermission();
  });

  onDestroy(() => {
    clearInterval(clockTimer);
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

    const freq = freqInput.replace(/[^0-9.]/g, '').trim();
    const callsign = callsignInput.replace(/[^A-Z0-9\-_ ]/gi, '').trim().toUpperCase();

    if (!freq) { joinError = 'Masukkan frekuensi'; return; }
    if (!callsign) { joinError = 'Masukkan callsign / nama panggilanmu'; return; }
    if (callsign.length < 2) { joinError = 'Callsign minimal 2 karakter'; return; }

    localStorage.setItem('callsign', callsignInput);
    localStorage.setItem('lastFrequency', freq);
    localStorage.setItem('role', role);

    if (!$isConnected) {
      joinError = 'Belum terhubung ke server. Coba lagi...';
      return;
    }

    joinChannel(freq, callsign, role);
    requestNotificationPermission(); // ask while we still have a user gesture
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

  function formatTs(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}Z`;
  }

  // Only show entries from today (UTC)
  $: todayLog = $visitLog.filter((e) => {
    const now = new Date();
    const t = new Date(e.joinedAt);
    return t.getUTCFullYear() === now.getUTCFullYear() &&
           t.getUTCMonth() === now.getUTCMonth() &&
           t.getUTCDate() === now.getUTCDate();
  });
</script>

<svelte:head>
  <title>PVA.HT</title>
</svelte:head>

<div class="relative z-10 min-h-screen flex flex-col items-center justify-start px-4 py-6 gap-6 max-w-md mx-auto">
  <!-- Header -->
  <header class="w-full flex items-center justify-between">
    <div>
      <h1 class="font-mono text-lg text-slate-200 tracking-widest">✦ PVA.HT</h1>
      <p class="font-mono text-xs text-slate-500 tracking-widest">PAPUA VIRTUAL AVIATION</p>
    </div>
    <div class="flex flex-col items-end gap-1">
      <span class="font-mono text-xs text-amber-400 tracking-widest tabular-nums">{utcClock}</span>
      <SignalMeter />
    </div>
  </header>

  {#if !$isInChannel}
    <!-- ========== JOIN SCREEN ========== -->
    <div class="w-full space-y-6">

      <!-- Frequency display -->
      <div class="bg-space-800 border border-slate-700/50 rounded-2xl p-5">
        <label for="freq-input" class="block text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">
          Frekuensi
        </label>
        <input
          id="freq-input"
          value={freqInput}
          on:input={handleFreqInput}
          type="text"
          inputmode="numeric"
          maxlength="7"
          placeholder="118.575"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          class="
            lcd w-full bg-transparent text-3xl text-amber-400 placeholder-slate-700
            border-none outline-none tracking-widest
          "
          on:keydown={(e) => e.key === 'Enter' && handleJoin()}
        />
        <div class="mt-2 h-px bg-amber-400/30"></div>
        <p class="mt-2 text-xs text-slate-600 font-mono">
          Masukkan frekuensi ATC, contoh: 118.575
        </p>
      </div>

      <!-- Role selector -->
      <div class="flex gap-3">
        <button
          on:click={() => role = 'pilot'}
          class="flex-1 py-3 rounded-xl font-mono text-sm uppercase tracking-widest border-2 transition-all duration-150
            {role === 'pilot'
              ? 'border-sky-400 bg-sky-400/10 text-sky-400'
              : 'border-slate-700 text-slate-600 hover:border-slate-600'}"
        >
          ✈ Pilot
        </button>
        <button
          on:click={() => role = 'atc'}
          class="flex-1 py-3 rounded-xl font-mono text-sm uppercase tracking-widest border-2 transition-all duration-150
            {role === 'atc'
              ? 'border-amber-400 bg-amber-400/10 text-amber-400'
              : 'border-slate-700 text-slate-600 hover:border-slate-600'}"
        >
          📡 ATC
        </button>
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

      <!-- Frequency Directory -->
      {#if $frequencyDirectory.length > 0}
        <div class="w-full">
          <p class="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Frekuensi Aktif</p>
          <div class="space-y-2">
            {#each $frequencyDirectory as entry (entry.frequency)}
              <button
                on:click={() => { freqInput = entry.frequency; }}
                class="w-full flex items-center justify-between bg-space-800 border border-slate-700/50 rounded-xl px-4 py-3 hover:border-mint/40 transition-colors text-left"
              >
                <span class="font-mono text-amber-400 tracking-widest lcd">{entry.frequency}</span>
                <div class="flex items-center gap-2 font-mono text-xs">
                  {#if entry.pilotCount > 0}
                    <span class="text-sky-400">{entry.pilotCount} PIL</span>
                  {/if}
                  {#if entry.pilotCount > 0 && entry.atcCount > 0}
                    <span class="text-slate-600">·</span>
                  {/if}
                  {#if entry.atcCount > 0}
                    <span class="text-amber-400">{entry.atcCount} ATC</span>
                  {/if}
                  <span class="text-slate-500 ml-1">{entry.memberCount} online</span>
                </div>
              </button>
            {/each}
          </div>
        </div>
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

    <!-- Visit log — shown below leave button -->
    <div class="w-full bg-space-800 border border-slate-700/30 rounded-xl p-3">
      <p class="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Log Hari Ini</p>
      {#if todayLog.length === 0}
        <p class="text-xs font-mono text-slate-700">Belum ada log hari ini</p>
      {:else}
        <div class="max-h-40 overflow-y-auto space-y-1.5">
          {#each [...todayLog].reverse() as entry (entry.sessionId + entry.joinedAt)}
            <div class="flex items-center gap-1.5 font-mono text-xs">
              <span class="px-1 py-0.5 rounded text-xs leading-none flex-shrink-0
                {entry.role === 'atc' ? 'bg-amber-400/15 text-amber-400' : 'bg-sky-400/10 text-sky-400'}">
                {entry.role === 'atc' ? 'ATC' : 'PIL'}
              </span>
              <span class="text-slate-300 truncate flex-1 min-w-0">{entry.callsign}</span>
              <span class="text-slate-500 tabular-nums flex-shrink-0">{formatTs(entry.joinedAt)}</span>
              <span class="tabular-nums flex-shrink-0 {entry.leftAt ? 'text-slate-600' : 'text-mint'}">
                {entry.leftAt ? formatTs(entry.leftAt) : '• ONLINE'}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Footer -->
  <footer class="mt-auto pt-4 text-center">
    <p class="text-slate-700 text-xs font-mono">PVA.HT · Papua Virtual Aviation</p>
  </footer>
</div>
