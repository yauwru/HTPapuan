<script lang="ts">
  import { members, currentCallsign, speakerSessionId } from '$lib/stores/channel.js';
</script>

<div class="bg-space-800 rounded-xl p-3 space-y-1.5">
  <p class="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Anggota Channel</p>

  {#if $members.length === 0}
    <p class="text-slate-600 text-sm font-mono">— menunggu —</p>
  {:else}
    {#each $members as member (member.sessionId)}
      {@const isSpeaking = $speakerSessionId === member.sessionId}
      {@const isMe = member.callsign === $currentCallsign}
      <div class="flex items-center gap-2 py-0.5">
        <!-- Signal dot -->
        <div
          class="w-2 h-2 rounded-full flex-shrink-0 transition-colors duration-200"
          class:bg-mint={isSpeaking}
          class:animate-pulse={isSpeaking}
          class:bg-green-500={!isSpeaking}
        ></div>

        <!-- Role badge -->
        <span class="font-mono text-xs px-1 py-0.5 rounded leading-none flex-shrink-0
          {member.role === 'atc'
            ? 'bg-amber-400/15 text-amber-400 border border-amber-400/30'
            : 'bg-sky-400/10 text-sky-400 border border-sky-400/20'}">
          {member.role === 'atc' ? 'ATC' : 'PIL'}
        </span>

        <!-- Callsign -->
        <span
          class="font-mono text-sm tracking-wide transition-colors duration-200"
          class:text-mint={isSpeaking}
          class:text-slate-100={!isSpeaking}
        >
          {member.callsign}{isMe ? ' (kamu)' : ''}
        </span>

        <!-- On-air badge -->
        {#if isSpeaking}
          <span class="ml-auto text-xs font-mono text-mint bg-mint/10 px-1.5 py-0.5 rounded">
            ON AIR
          </span>
        {/if}
      </div>
    {/each}
  {/if}
</div>
