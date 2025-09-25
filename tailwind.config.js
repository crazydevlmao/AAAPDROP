/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./lib/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f0f13",
        panel: "#16161c",
        accent: "#00FFC2",
        accentDim: "#00cfa0",
      },
      boxShadow: {
        glow: "0 0 24px rgba(0,255,194,0.35)",
        insetGlow: "0 0 60px rgba(0,255,194,0.25) inset",
      },
      borderRadius: { "2xl": "1rem" },
    },
  },
  plugins: [],
};
