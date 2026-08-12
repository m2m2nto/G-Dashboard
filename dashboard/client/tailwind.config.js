/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2E6BAD',
          hover: '#245A91',
          light: '#EDF2F8',
        },
        accent: {
          DEFAULT: '#EB583D',
          hover: '#D14830',
          light: '#FEF0ED',
        },
        surface: {
          DEFAULT: '#ffffff',
          dim: '#f1f3f4',
          container: '#f8f9fa',
          border: '#dadce0',
        },
        'on-surface': {
          DEFAULT: '#1B2B3D',
          secondary: '#4D5E6F',
          tertiary: '#7E8D9B',
        },
        status: {
          positive: '#1e8e3e',
          negative: '#d93025',
          warning: '#f9ab00',
        },
        cf: {
          'cost': '#FFFF00',
          'revenue': '#B4C6E7',
          'financing': '#FFC000',
          'pos': '#006100',
          'pos-bg': '#C6EFCE',
          'neg': '#9C0006',
          'neg-bg': '#FFC7CE',
        },
        snackbar: '#323232',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      width: {
        sidebar: '200px',
        'sidebar-collapsed': '56px',
        'drawer': '384px',
      },
      maxWidth: {
        content: '1400px',
      },
      boxShadow: {
        'elevation-1': '0 1px 2px 0 rgba(60,64,67,0.3), 0 1px 3px 1px rgba(60,64,67,0.15)',
        'elevation-2': '0 1px 2px 0 rgba(60,64,67,0.3), 0 2px 6px 2px rgba(60,64,67,0.15)',
        'elevation-3': '0 1px 3px 0 rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15)',
        'elevation-4': '0 2px 3px 0 rgba(60,64,67,0.3), 0 6px 10px 4px rgba(60,64,67,0.15)',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
};
