import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://syncspace.dev"),
  title: {
    default: "SyncSpace — Collaborative Code Editor",
    template: "%s | SyncSpace",
  },
  description:
    "Real-time collaborative code editor with sub-50ms keystroke sync via Yjs CRDTs, multi-file workspaces, sandboxed Docker execution, and embedded AI assistance.",
  keywords: [
    "collaborative code editor",
    "real-time pair programming",
    "CRDT",
    "Yjs",
    "sandboxed execution",
    "Docker sandbox",
    "AI coding assistant",
  ],
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/favicon.svg", color: "#3B82F6" },
    ],
  },
  openGraph: {
    title: "SyncSpace — Collaborative Code Editor",
    description:
      "Sub-50ms keystroke sync via Yjs CRDTs, multi-file workspaces, sandboxed Docker execution, and embedded AI assistance.",
    url: "https://syncspace.dev",
    siteName: "SyncSpace",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "SyncSpace — Collaborative Code Editor",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SyncSpace — Collaborative Code Editor",
    description:
      "Sub-50ms keystroke sync via Yjs CRDTs, multi-file workspaces, sandboxed Docker execution, and embedded AI assistance.",
    images: ["/og-image.png"],
  },
};

// Inline script to apply theme before first paint, preventing flash
const themeScript = `
  (function() {
    var stored = localStorage.getItem('syncspace_theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
