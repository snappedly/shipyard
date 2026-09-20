import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata = {
  title: "Shipyard",
  description: "Documentation for Snappedly's agent orchestration tool.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
