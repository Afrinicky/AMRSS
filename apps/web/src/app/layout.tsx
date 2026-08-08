import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AMRSS — Antimicrobial Resistance Surveillance System",
    template: "%s · AMRSS",
  },
  description:
    "Continuously updated antimicrobial susceptibility and resistance intelligence derived from routine microbiology data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
