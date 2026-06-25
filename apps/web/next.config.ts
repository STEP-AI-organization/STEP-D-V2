import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));
loadEnvConfig(resolve(webRoot, "../.."));

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  agentRules: false,
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8010"
  },
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.13.109", "100.85.157.120"],
  experimental: {
    // Turbopack's experimental persistent dev cache fails to commit on Windows
    // ("Persisting failed … os error 5"). Disable it to silence the error;
    // in-session HMR is unaffected, only cross-restart caching is skipped.
    turbopackFileSystemCacheForDev: false
  }
};

export default nextConfig;
