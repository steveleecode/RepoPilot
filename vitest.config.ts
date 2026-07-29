import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@repopilot/analyzer": new URL("./packages/analyzer/src/index.ts", import.meta.url).pathname,
      "@repopilot/generator": new URL("./packages/generator/src/index.ts", import.meta.url)
        .pathname,
      "@repopilot/instruction-linter": new URL(
        "./packages/instruction-linter/src/index.ts",
        import.meta.url
      ).pathname,
      "@repopilot/policy": new URL("./packages/policy/src/index.ts", import.meta.url).pathname,
      "@repopilot/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@repopilot/validator": new URL("./packages/validator/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    globals: false,
    environment: "node"
  }
});
