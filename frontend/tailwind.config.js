/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#4040d9',
          hover: '#3006c2',
        },
        success: '#11845b',
        warning: '#ffd200',
        danger: '#b2001e',
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
        sans: ['"Open Sans"', 'sans-serif'],
      },
      fontSize: {
        base: '0.8125rem',
        lg: '0.9375rem',
        sm: '0.75rem',
      },
      borderRadius: {
        DEFAULT: '4px',
      }
    },
  },
  plugins: [],
}
