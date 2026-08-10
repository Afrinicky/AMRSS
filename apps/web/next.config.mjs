/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Deliberately no `env:` block. Next's `env` config inlines values into the
  // bundle at build time — that is what it is for — so listing AMRSS_API_URL
  // there baked whatever was set during `next build` (in a container build,
  // nothing, hence the localhost fallback) into the image and made the runtime
  // variable inert. Every page then failed in production while working locally.
  //
  // The dashboard reads the API server-side only, so the value never needs to
  // reach the browser and can simply be read from the environment per request.
};

export default nextConfig;
