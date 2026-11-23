import { defineConfig } from "@lingui/conf";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"],
  // Untranslated messages render English, not their generated hash id.
  fallbackLocales: { default: "en" },
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      // The auth error texts are shared with the iPhone, so they live in core.
      include: ["src", "../../packages/core/src/signup-policy.ts"],
      exclude: ["**/locales/**", "**/*.test.*", "**/*.d.ts"],
    },
  ],
  compileNamespace: "es",
});
