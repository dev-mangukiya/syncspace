import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    // In Docker, use the service name; locally, use localhost
    const wsServerUrl = process.env.INTERNAL_WS_URL || process.env.NEXT_PUBLIC_WS_SERVER_URL || "http://localhost:8080";
    return [
      {
        source: "/api/auth/:path*",
        destination: `${wsServerUrl}/api/auth/:path*`,
      },
      {
        source: "/api/workspaces/:path*",
        destination: `${wsServerUrl}/api/workspaces/:path*`,
      },
      {
        source: "/api/ai/:path*",
        destination: `${wsServerUrl}/api/ai/:path*`,
      },
      {
        source: "/api/exec/:path*",
        destination: `${wsServerUrl}/api/exec/:path*`,
      },
      {
        source: "/api/ws-ticket",
        destination: `${wsServerUrl}/api/ws-ticket`,
      },
      {
        source: "/health",
        destination: `${wsServerUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
