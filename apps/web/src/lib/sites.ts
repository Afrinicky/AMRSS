/** A URL-safe slug for an infection site, e.g. "urinary tract" → "urinary-tract".
 *  Used for the /empiric/[site] routes; the original name is recovered by
 *  matching the slug against the sites list rather than un-slugging. */
export function siteSlug(site: string): string {
  return (
    site
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "site"
  );
}
