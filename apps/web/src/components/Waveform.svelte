<script lang="ts">
  export let active = false;

  const bars = [0.3, 0.6, 0.9, 1.0, 0.8, 0.5, 0.7, 0.4, 0.6, 0.8, 1.0, 0.7, 0.4];
  const delays = bars.map(() => Math.random() * 0.5);
</script>

<div class="flex items-end justify-center gap-0.5 h-8" aria-hidden="true">
  {#each bars as height, i}
    <div
      class="w-1.5 rounded-full transition-colors duration-300"
      class:bg-mint={active}
      class:bg-slate-700={!active}
      style="
        height: {active ? Math.max(height * 100, 20) : 20}%;
        animation: {active ? `waveform ${0.4 + delays[i] * 0.4}s ease-in-out ${delays[i]}s infinite alternate` : 'none'};
      "
    ></div>
  {/each}
</div>
