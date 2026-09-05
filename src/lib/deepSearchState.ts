// Whether a deep search is running, readable outside SearchView.
//
// The Sidebar's source switcher consults this before flipping providers: a
// flip wipes the Search page, so mid-scan it asks first instead of silently
// discarding a walk the user may have waited seconds for. Plain module state
// (same shape as useCurrentSource) — the one reader samples it at click time,
// so no subscription is needed.

type DeepSearchState = { inFlight: boolean; query: string };

let _state: DeepSearchState = { inFlight: false, query: '' };

export function setDeepSearchInFlight(inFlight: boolean, query = ''): void {
  _state = { inFlight, query: inFlight ? query : '' };
}

export function getDeepSearchState(): DeepSearchState {
  return _state;
}
