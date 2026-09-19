/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#111827",
        secondary: "#4B5563",
        "muted-body": "#374151",
        "surface-canvas": "#FFFFFF",
        "surface-sub": "#F9FAFB",
        "surface-inset": "#F3F4F6",
        "border-hairline": "#E5E7EB",
        "accent-mono": "#047857",
        cg: {
          bgMain: '#FFFFFF',
          bgSidebar: '#F9F9F9',
          bgCard: '#FFFFFF',
          bgCardSubtle: '#F4F4F4',
          borderSubtle: '#E5E5E5',
          borderActive: '#0D0D0D',
          accent: '#0D0D0D',
          accentBlue: '#1075E3',
          statusGreen: '#10A37F',
          txtMain: '#0D0D0D',
          txtMuted: '#5D5D5D',
          txtDim: '#8E8E8E',
          amberBadge: '#B45309',
          amberBadgeBg: '#FEF3C7',
        }
      },
      fontFamily: {
        sans: ['Geist', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
