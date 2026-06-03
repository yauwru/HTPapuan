<script lang="ts">
  import { signalStrength, connectionState } from '$lib/stores/channel.js';

  const labels: Record<string, string> = {
    idle: 'OFFLINE',
    connecting: 'KONEK...',
    connected: 'ONLINE',
    reconnecting: 'NYAMBUNG...',
    error: 'ERROR',
  };
</script>

<div class="flex items-center gap-2">
  <span class="text-xs font-mono text-slate-400">
    {labels[$connectionState] ?? 'UNKNOWN'}
  </span>
  <div class="flex items-end gap-0.5 h-4">
    {#each [1, 2, 3, 4, 5] as level}
      <div
        class="w-1.5 rounded-sm transition-colors duration-300"
        style="height: {level * 20}%"
        class:bg-mint={$signalStrength >= level && $connectionState === 'connected'}
        class:bg-amber-400={$signalStrength >= level && $connectionState === 'reconnecting'}
        class:bg-slate-700={$signalStrength < level || $connectionState !== 'connected' && $connectionState !== 'reconnecting'}
      ></div>
    {/each}
  </div>
</div>
