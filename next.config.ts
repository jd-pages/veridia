import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/@prisma/client/**/*",
      "node_modules/.prisma/client/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "*": [
      ".env*",
      "backups/**/*",
      ".playwright/**/*",
      "logs/**/*",
      "outputs/**/*",
      "artifacts/**/*",
      "release/**/*",
      "dist-installer/**/*",
      "desktop-runtime/**/*",
      "prisma/*.db",
      "prisma/*.db-journal",
      "test-results/**/*",
      "playwright-report/**/*",
    ],
  },
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      {
        source: "/api/extension/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, X-Extension-Token",
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, OPTIONS",
          },
          { key: "Access-Control-Allow-Private-Network", value: "true" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default nextConfig;
