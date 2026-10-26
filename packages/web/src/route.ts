import { useCallback, useEffect, useState } from 'react';

/**
 * Where the owner app is, kept in the URL so a reload, back and forward, and
 * a pasted link land on the same page. The Worker answers any path it does
 * not route with the app shell (wrangler.toml), so these need no server side.
 */
export type Page = 'photos' | 'albums' | 'tags' | 'settings';
export interface Route { page: Page; album?: string }

const PAGES: Page[] = ['photos', 'albums', 'tags', 'settings'];

/** Anything unknown, and `/`, is the timeline. */
export function parseRoute(path: string): Route {
  const [first, second] = path.split('/').filter(Boolean);
  const page = PAGES.find((p) => p === first) ?? 'photos';
  if (page === 'albums' && second) {
    // A mangled escape is an album that does not exist, not a crash.
    try { return { page, album: decodeURIComponent(second) }; } catch { /* falls through */ }
  }
  return { page };
}

export const routePath = (r: Route) =>
  r.album ? `/albums/${encodeURIComponent(r.album)}` : `/${r.page}`;

/** The current route, and a way to go to another (a new history entry unless `replace`). */
export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));

  useEffect(() => {
    // `/` and unknown paths show as the page they open.
    if (routePath(route) !== window.location.pathname) history.replaceState(null, '', routePath(route));
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((r: Route, replace = false) => {
    const path = routePath(r);
    if (path !== window.location.pathname) {
      if (replace) history.replaceState(null, '', path);
      else { history.pushState(null, '', path); window.scrollTo(0, 0); }
    }
    setRoute(r);
  }, []);

  return [route, go];
}
