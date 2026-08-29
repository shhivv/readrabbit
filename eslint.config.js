// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    files: ["src/app/index.tsx"],
    rules: {
      // Reanimated shared values are mutable by design, and Gesture callbacks
      // run after render. React's generic compiler rules cannot model either.
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
    },
  },
  {
    files: ["harness/**/*.{ts,tsx}"],
    rules: {
      // Bun plugins expose module replacements through synchronous require().
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);
