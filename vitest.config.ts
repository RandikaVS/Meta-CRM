import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping. Was
    // previously unset, which silently broke every test file that
    // imports through the `@/` alias (18/66 files failing to even
    // load, "Cannot find package '@/...'") — `npm test` exiting 0
    // regardless, since vitest only reports the files it could run.
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "3da309f3e3edbd1425ee8b50bd842416f2e2df27206fb43fc455e2498f6f62b6",
      META_APP_SECRET: "d9c909330004b881cf11a0f470b371bc",
    },
    clearMocks: true,
  },
});
