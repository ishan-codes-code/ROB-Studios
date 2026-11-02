import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Commentator — Every game has a story",
  description:
    "An intelligent commentary engine in development, built to turn gameplay into a story worth watching.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased dark"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
