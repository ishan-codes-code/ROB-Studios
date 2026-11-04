import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Commentator — Every game has a story",
  description:
    "An intelligent commentary engine in development that reads gameplay, builds match context, and turns supported moments into commentary. Includes the desktop Commentary Studio.",
  keywords: ["AI commentary", "gameplay analysis", "esports broadcast", "commentary engine"],
  openGraph: {
    title: "AI Commentator — Every game has a story",
    description: "Gameplay in. A story out. An intelligent commentary engine and desktop Commentary Studio, in development.",
    type: "website",
    siteName: "AI Commentator",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Commentator — Every game has a story",
    description: "Gameplay in. A story out. An intelligent commentary engine and desktop Commentary Studio, in development.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
