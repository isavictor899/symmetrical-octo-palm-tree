import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// Messages from Enora Labs (maintenance, new features). Information and
// warnings can be dismissed on this device; critical ones stay until they end.

const dismissedKey = (userId) => `pharmacy-pos:announcements-dismissed:${userId}`;

function readDismissed(userId) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(dismissedKey(userId)) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export default function AnnouncementBar({ userId }) {
  const [items, setItems] = useState([]);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));

  useEffect(() => {
    if (!userId) return undefined;
    setDismissed(readDismissed(userId));
    let cancelled = false;
    const load = () => {
      if (navigator.onLine === false) return;
      supabase.rpc('get_my_announcements').then(({ data, error }) => {
        if (!cancelled && !error) setItems(data || []);
      });
    };
    load();
    const timer = window.setInterval(load, 30 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [userId]);

  function dismiss(id) {
    const next = new Set([...dismissed, id]);
    setDismissed(next);
    try { window.localStorage.setItem(dismissedKey(userId), JSON.stringify([...next].slice(-50))); } catch { /* storage may be off */ }
  }

  const visible = items.filter((item) => item.level === 'critical' || !dismissed.has(item.id));
  if (!visible.length) return null;

  return (
    <div className="announcement-stack">
      {visible.map((item) => (
        <div key={item.id} className={`announcement ${item.level}`} role={item.level === 'critical' ? 'alert' : 'status'}>
          <div>
            <strong>{item.title}</strong>
            <span>{item.body}</span>
          </div>
          {item.level !== 'critical' ? (
            <button type="button" onClick={() => dismiss(item.id)} aria-label={`Dismiss ${item.title}`}>Dismiss</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}