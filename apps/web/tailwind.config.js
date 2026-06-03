/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        space: {
          950: '#0A0E1A',
          900: '#111827',
          800: '#1C2537',
        },
        mint: '#6EE7B7',
        indigo: '#818CF8',
        amber: '#F59E0B',
      },
      fontFamily: {
        mono: ['"Share Tech Mono"', 'Courier Prime', 'Courier New', 'monospace'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 1.5s ease-in-out infinite',
        'waveform': 'waveform 0.8s ease-in-out infinite alternate',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 10px #6EE7B7, 0 0 20px #6EE7B740' },
          '50%': { boxShadow: '0 0 20px #6EE7B7, 0 0 40px #6EE7B770, 0 0 60px #6EE7B730' },
        },
        'waveform': {
          '0%': { transform: 'scaleY(0.3)' },
          '100%': { transform: 'scaleY(1)' },
        },
      },
    },
  },
};
