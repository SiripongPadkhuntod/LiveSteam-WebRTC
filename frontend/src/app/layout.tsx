import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LocalStream Studio",
  description: "Low-latency local WebRTC broadcasting studio",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
