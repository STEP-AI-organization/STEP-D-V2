/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serve the React port of the STEP D Review OS prototype (src/app/os) at the site
  // root. The real app routes (/programs, /clips, …) stay reachable. The raw-HTML
  // prototype remains at /review-os.html as a reference.
  async redirects() {
    return [{ source: "/", destination: "/os", permanent: false }];
  },
};

export default nextConfig;
