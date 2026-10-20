/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f4f0e6",
        ink: "#1c2430",
        navy: "#1b3a4b",
        line: "#d9d1c3",
        match: "#0e6b3c",
        review: "#8a5800",
        mismatch: "#9d2218",
      },
      fontFamily: {
        serif: ['Palatino', '"Palatino Linotype"', '"Iowan Old Style"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
