import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Packages that load files or connect at runtime: keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
