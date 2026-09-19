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
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger: 'hsl(var(--danger))',
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
        'on-accent': 'rgb(var(--on-accent) / <alpha-value>)',
        'quota-ok': 'hsl(var(--quota-ok))',
        'quota-warn': 'hsl(var(--quota-warn))',
        'quota-danger': 'hsl(var(--quota-danger))',
        'quota-ok-track': 'hsl(var(--quota-ok-track))',
        'quota-warn-track': 'hsl(var(--quota-warn-track))',
        'quota-danger-track': 'hsl(var(--quota-danger-track))',
        // Tailwind's own hue scales, pointed at CSS variables so a theme family
        // can swap them. Lens sets the stock Tailwind values (styles.css), so
        // every existing `amber-50` / `emerald-500` class renders unchanged.
        ...Object.fromEntries(
          ['amber', 'emerald', 'rose', 'violet', 'sky', 'blue', 'pink', 'orange', 'purple', 'fuchsia', 'teal', 'cyan', 'indigo', 'slate'].map(hue => [
            hue,
            Object.fromEntries(
              [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map(shade => [shade, `rgb(var(--${hue}-${shade}) / <alpha-value>)`]),
            ),
          ]),
        ),
      },
      // Type, radii and shadows are theme-family variables too (styles.css).
      fontFamily: {
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
        reading: 'var(--font-reading)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
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
        progressSweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
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
        'progress-sweep': 'progressSweep 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite',
      },
    },
  },
  plugins: [],
};
