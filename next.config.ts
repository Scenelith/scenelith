import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // Preserve Next's pre-16.3 test/mock exclusions with the CLI type checker.
    // The test runner still executes the full suite independently.
    tsconfigPath: "tsconfig.build.json",
  },
  experimental: {
    proxyClientMaxBodySize: "300mb",
  },
};

export default nextConfig;
