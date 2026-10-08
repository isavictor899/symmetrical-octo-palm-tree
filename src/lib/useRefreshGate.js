import { useEffect, useRef, useState } from 'react';

// Returns a counter that changes only when a page should fetch again:
//   - the first time the page becomes active, and
//   - when the underlying data changed (dataVersion) since its last fetch.
// Switching tabs by itself does not change it, so the page keeps the data it
// already has instead of showing "Loading…" on every visit. If data changes
// while the page is hidden, the page refetches the next time it is opened.
export function useRefreshGate(isActive, dataVersion) {
const [gate, setGate] = useState(0); const seenVersion = useRef(null);

useEffect(() => {
    if (!isActive) return;
    if (seenVersion.current === null || seenVersion.current !== dataVersion) {
    seenVersion.current = dataVersion;
    setGate((value) => value + 1);
    }
}, [isActive, dataVersion]);

return gate;
}