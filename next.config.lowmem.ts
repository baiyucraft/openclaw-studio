import type { NextConfig } from "next";

const nextConfigLowmem: NextConfig = {
  serverExternalPackages: ["ws", "better-sqlite3"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config) => {
    config.parallelism = 1;
    return config;
  },
};

export default nextConfigLowmem;
