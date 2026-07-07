import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep `next build` from overwriting chunks used by a running dev server.
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
};

export default nextConfig;
