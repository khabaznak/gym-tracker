/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'media',
  content: [
    "./public/**/*.html",
    "./src/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0b0b0b',
        graphite: '#2f3437',
        fog: '#f3f4f6',
        teal: {
          DEFAULT: '#0f766e',
          dark: '#0c4f4a',
        },
        orange: {
          DEFAULT: '#f97316',
          dark: '#ea580c',
        },
      },
      fontFamily: {
        sans: ['Helvetica', 'Arial', 'ui-sans-serif', 'system-ui'],
      },
    },
  },
  plugins: [],
};
