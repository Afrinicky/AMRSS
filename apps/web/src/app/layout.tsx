import type { Metadata } from "next";
import "./globals.css";

/**
 * How long Vercel lets a server render run, in seconds.
 *
 * Every page here renders on the server and waits for the surveillance API,
 * which on the free tier may be spinning up — roughly a minute after fifteen
 * minutes of inactivity. Vercel's default budget is well short of that, and a
 * render it cuts short becomes a platform 504: a page this application never
 * gets to render, explain, or offer to retry.
 *
 * 60 is deliberately the *plan-independent* ceiling. It is the maximum a Hobby
 * function may declare without Fluid compute, and comfortably inside the limit
 * with it, so this holds whether or not that setting is ever changed. The
 * client's own deadline (`API_TIMEOUT_MS`, 50s) sits inside it on purpose.
 */
export const maxDuration = 60;

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
