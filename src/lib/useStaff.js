import { useCallback, useEffect, useRef, useState } from 'react';
import { usePowerSync, useStatus } from '@powersync/react';
import { supabase } from './supabaseClient';
import { readLocalStaff, syncStaffFromRemote } from './staff';

const MAX_BACKOFF_STEP = 12;
const SYNCED_NOTICE_MS = 5000;

async function getSignedInUserId() {
  // Reads the session from local storage — no network call, so offline-safe.
const { data: { session } } = await supabase.auth.getSession();
return session?.user?.id ?? null;
}

/**
 * Resolves the signed-in user's staff row (id, shopId, role), local-first.
 *
 *   keepTrying: false (default) — if the local row is missing, make ONE
 *     remote attempt and report a failure through `error`.
 *   keepTrying: true — keep fetching in the background with backoff until it
 *     succeeds (waking immediately when the connection comes back). No
 *     blocking error is set, so callers can just keep showing "Loading…".
 *
 * Returns:
 *   staff         { id, shopId, role } | null
 *   error         { code: 'not_signed_in' | 'lookup_failed', message } | null
 *   retrying      true while a manual retry() is in flight
 *   syncedNotice  true for a few seconds after the row was pulled from the server
 *   retry()       manual "fetch it from the server now"
 */
export function useStaff({ keepTrying = false } = {}) {
const db = usePowerSync();
const connected = Boolean(useStatus()?.connected);

const [staff, setStaff] = useState(null);
const [error, setError] = useState(null);
const [retrying, setRetrying] = useState(false);
const [syncedNotice, setSyncedNotice] = useState(false);

  // Refs so the long-running loop always sees the CURRENT connectivity,
  // instead of the value captured when the effect started.
const connectedRef = useRef(connected);
const wakeRef = useRef(null);
const noticeTimer = useRef(null);

useEffect(() => {
    connectedRef.current = connected;
    if (connected) wakeRef.current?.(); // back online — retry right away
}, [connected]);

useEffect(() => () => clearTimeout(noticeTimer.current), []);

const announceSynced = useCallback(() => {
    setSyncedNotice(true);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSyncedNotice(false), SYNCED_NOTICE_MS);
}, []);

useEffect(() => {
    let cancelled = false;

    // A sleep that connectivity changes (or unmount) can cut short.
    const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
        clearTimeout(timer);
        if (wakeRef.current === finish) wakeRef.current = null;
        resolve();
    }
    wakeRef.current = finish;
    });

    async function resolveStaff() {
    const userId = await getSignedInUserId();
    if (cancelled) return;
    if (!userId) {
        setError({ code: 'not_signed_in', message: 'Not signed in.' });
        return;
    }

    const local = await readLocalStaff(db, userId);
    if (cancelled) return;
    if (local) {
        setStaff(local);
        setError(null);
        return;
    }

    if (!keepTrying) {
        try {
        const remote = await syncStaffFromRemote(db, userId);
        if (cancelled) return;
        setStaff(remote);
        setError(null);
        } catch (err) {
        console.error('[useStaff] staff lookup failed for', userId, err);
        if (!cancelled) setError({ code: 'lookup_failed', message: err?.message || String(err) });
        }
        return;
    }

    let attempts = 0;
    while (!cancelled) {
        if (!connectedRef.current && !navigator.onLine) {
        await sleep(3000);
        continue;
        }
        try {
        const remote = await syncStaffFromRemote(db, userId);
        if (cancelled) return;
        setStaff(remote);
        setError(null);
        announceSynced();
        return;
        } catch (err) {
        console.warn('[useStaff] remote staff fetch failed:', err?.message || err);
        attempts = Math.min(attempts + 1, MAX_BACKOFF_STEP);
          await sleep(Math.min(2000 * 2 ** attempts, 60000));
        }
    }
    }

    resolveStaff().catch((err) => console.error('[useStaff] unexpected failure:', err));

    return () => {
    cancelled = true;
      wakeRef.current?.(); // let a sleeping loop notice and exit
    };
}, [db, keepTrying, announceSynced]);

const retry = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
    const userId = await getSignedInUserId();
    if (!userId) {
        setError({ code: 'not_signed_in', message: 'Not signed in.' });
        return;
    }
    setStaff(await syncStaffFromRemote(db, userId));
    announceSynced();
    } catch (err) {
    setError({ code: 'lookup_failed', message: err?.message || String(err) });
    } finally {
    setRetrying(false);
    }
}, [db, announceSynced]);

return { staff, error, retrying, syncedNotice, retry };
}