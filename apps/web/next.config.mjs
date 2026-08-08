/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard reads the API server-side, so the browser never holds a token
  // and never talks to the API directly.
  env: {
    AMRSS_API_URL: process.env.AMRSS_API_URL ?? "http://localhost:8000",
  },
};

export default nextConfig;
