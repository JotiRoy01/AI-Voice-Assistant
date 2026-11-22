import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#dbe7ff',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
          950: '#0f172a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
