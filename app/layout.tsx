import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free TTS Studio",
  description: "Text to speech, free forever — powered by Edge neural voices.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
