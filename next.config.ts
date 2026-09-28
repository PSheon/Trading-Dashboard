import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native bindings: load with Node's require instead of bundling.
  serverExternalPackages: ["@duckdb/node-api"],
};

export default nextConfig;
