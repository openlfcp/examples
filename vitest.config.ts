import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["todo-cli/test/**/*.test.ts", "qualification/test/**/*.test.ts"],
  },
});
