import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";

loadEnvConfig(resolve(process.cwd(), "../.."));

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  agentRules: false,
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8010"
  },
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Turbopack's experimental persistent dev cache fails to commit on Windows
    // ("Persisting failed … os error 5"). Disable it to silence the error;
    // in-session HMR is unaffected, only cross-restart caching is skipped.
    turbopackFileSystemCacheForDev: false
  }
};

export default nextConfig;
