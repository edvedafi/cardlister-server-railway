/**
 * Sites listed in DISABLED_SITES (comma-separated, e.g. "sportlots,bsc") are skipped by both the
 * sales poller and the listing sync. Meant for temporary outages — flip the env var in Railway
 * rather than shipping a code change.
 */
export function isSiteDisabled(site: string): boolean {
  return (process.env.DISABLED_SITES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(site.toLowerCase());
}
