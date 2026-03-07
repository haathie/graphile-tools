import config from "@adiwajshing/eslint-config";
import { defineConfig } from "eslint/config";
import graphileExport from "eslint-plugin-graphile-export";

export default defineConfig([
  {
    ignores: [
      "**/lib/**",
      "**/coverage/**",
      "*.lock",
      ".eslintrcjson",
      "**/src/types/gen.ts",
      "**/src/migrations/**",
      "jest.config.js",
      "**/src/routes/index.ts",
    ],
  },
  {
    plugins: {
      "graphile-export": graphileExport,
    },
    rules: {
      ...graphileExport.configs.recommended.rules,
    },
  },
  {
    extends: [config],
    files: ["packages/*/src/**/*.{ts,tsx}"],
  },
]);
