/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--bg))',
        surface: 'hsl(var(--surface))',
        elevated: 'hsl(var(--elevated))',
        border: 'hsl(var(--border))',
        'border-soft': 'hsl(var(--border-soft))',
        muted: 'hsl(var(--muted))',
        text: 'hsl(var(--text))',
        'text-dim': 'hsl(var(--text-dim))',
        'text-muted': 'hsl(var(--text-muted))',
        accent: 'hsl(var(--accent))',
        'accent-soft': 'hsl(var(--accent-soft))',
        ring: 'hsl(var(--ring))',
        // semantic
        'token-total': 'hsl(var(--token-total))',
        'token-input': 'hsl(var(--token-input))',
        'token-output': 'hsl(var(--token-output))',
        'token-cacheread': 'hsl(var(--token-cacheread))',
        'token-cachewrite': 'hsl(var(--token-cachewrite))',
        'role-user': 'hsl(var(--role-user))',
        'role-assistant': 'hsl(var(--role-assistant))',
        'role-tool': 'hsl(var(--role-tool))',
        'role-summary': 'hsl(var(--role-summary))',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Inter Variable', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono Variable', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(16,16,24,0.04), 0 1px 1px rgba(16,16,24,0.03)',
        card: '0 1px 3px rgba(16,16,24,0.06), 0 1px 2px rgba(16,16,24,0.04)',
        pop: '0 12px 32px rgba(16,16,24,0.12)',
      },
      keyframes: {
        in: { '0%': { opacity: '0', transform: 'translateY(2px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        modalIn: {
          '0%': { opacity: '0', transform: 'translate(-50%, -50%) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        paletteIn: {
          '0%': { opacity: '0', transform: 'translateX(-50%) translateY(-6px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateX(-50%) translateY(0) scale(1)' },
        },
        drawerIn: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideRight: { '0%': { opacity: '0', transform: 'translateX(-6px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        pulse: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
      animation: {
        in: 'in 0.15s ease-out',
        'modal-in': 'modalIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        'palette-in': 'paletteIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        'drawer-in': 'drawerIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 0.15s ease-out',
        'fade-up': 'fadeUp 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-right': 'slideRight 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulse 2s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
};
