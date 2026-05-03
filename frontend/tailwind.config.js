/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#4040d9',
        'primary-hover': '#3006c2',
        'primary-pressed': '#4300d5',
        secondary: '#dde0ee',
        active: '#3759d8',
        'active-hover': '#1f37bd',
        state: '#ff5a4e',
        success: '#11845b',
        'success-hover': '#006640',
        info: '#389be1',
        'info-hover': '#007cc1',
        warning: '#ffd200',
        'warning-hover': '#d9ae00',
        danger: '#b2001e',
        'danger-hover': '#890008',
        helixNav: '#18222d',
        helixDivider: '#555868',
        gray: {
          100: '#f9fafa',
          200: '#f1f1f4',
          300: '#d5d6dd',
          400: '#b3b6c1',
          500: '#8c8fa1',
          600: '#707589',
          700: '#555868',
          800: '#393b46',
          900: '#22242a',
          1000: '#1c1d22',
        }
      },
      fontFamily: {
        sans: ["'Open Sans'", "-apple-system", "BlinkMacSystemFont", "'Segoe UI'", "Roboto", "sans-serif"],
        mono: ["'Source Code Pro'", 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        helix: ["'Open Sans'", "-apple-system", "BlinkMacSystemFont", "'Segoe UI'", "Roboto", "'Helvetica Neue'", "'Arial'", "sans-serif"],
      },
      fontSize: {
        tiny: '0.6875rem',   /* 11px  --fs-tiny  */
        sm:   '0.75rem',     /* 12px  --fs-small */
        base: '0.875rem',    /* 14px  --fs-body  */
        lg:   '1rem',        /* 16px  --fs-h4    */
        h3:   '1.25rem',     /* 20px  --fs-h3    */
        h2:   '1.5rem',      /* 24px  --fs-h2    */
        h1:   '2rem',        /* 32px  --fs-h1    */
        display: '2.5rem',   /* 40px  --fs-display */
      },
      boxShadow: {
        '1': '0 1px 2px rgba(34,36,42,0.08), 0 1px 3px rgba(34,36,42,0.06)',
        '2': '0 2px 6px rgba(34,36,42,0.10), 0 2px 4px rgba(34,36,42,0.06)',
        '3': '0 6px 16px rgba(34,36,42,0.12), 0 3px 6px rgba(34,36,42,0.08)',
        '4': '0 16px 32px rgba(34,36,42,0.16), 0 6px 12px rgba(34,36,42,0.10)',
      }
    },
  },
  plugins: [],
}
