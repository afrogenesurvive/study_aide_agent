import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["services/**/*.test.ts", "tests/**/*.test.ts", "src/main/**/*.test.ts"],
    reporters: process.env.CI ? ["default"] : ["dot"],
  },
});
