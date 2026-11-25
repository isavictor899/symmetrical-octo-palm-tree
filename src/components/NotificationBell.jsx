import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconClock,
  IconPackageImport,
  IconRefresh,
  IconShoppingCart,
} from '@tabler/icons-react';
import { supabase } from '../lib/supabaseClient';

const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });
const DAY_MS = 24 * 60 * 60 * 1000;

function readSeen(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function relativeTime(value) {
  if (!value) return 'Time unavailable';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

function nairobiDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export default function NotificationBell({ activeShopId, userId, onNavigatePage, availablePageKeys = [], dataVersion = 0 }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [seenIds, setSeenIds] = useState(() => new Set());

  const storageKey = useMemo(
    () => (userId && activeShopId ? `pharmacy-pos:notifications-read:${userId}:${activeShopId}` : null),
    [userId, activeShopId],
  );

  useEffect(() => {
    setSeenIds(storageKey ? readSeen(storageKey) : new Set());
    setItems([]);
    setError('');
  }, [storageKey]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const loadNotifications = useCallback(async () => {
    if (!activeShopId) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError('');
    const now = new Date();
    const recentSince = new Date(now.getTime() - DAY_MS).toISOString();
    const today = nairobiDate(now);
    const expiryLimit = nairobiDate(new Date(now.getTime() + 30 * DAY_MS));

    try {
      const [salesResult, movementsResult, expiryResult, reviewResult] = await Promise.all([
        supabase.from('sales')
          .select('id, total_amount, sold_at')
          .eq('shop_id', activeShopId)
          .gte('sold_at', recentSince)
          .order('sold_at', { ascending: false })
          .limit(12),
        supabase.from('stock_movements')
          .select('id, quantity, created_at, movement_type, batches(batch_number, drugs(name))')
          .eq('shop_id', activeShopId)
          .in('movement_type', ['received', 'transfer_in'])
          .gte('created_at', recentSince)
          .order('created_at', { ascending: false })
          .limit(12),
        supabase.from('batches')
          .select('id, batch_number, expiry_date, quantity_remaining, drugs(name)')
          .eq('shop_id', activeShopId)
          .gt('quantity_remaining', 0)
          .lte('expiry_date', expiryLimit)
          .order('expiry_date', { ascending: true })
          .limit(20),
        // Organization-wide; non-admins get zeros. A failure here must not
        // hide the other notifications.
        supabase.rpc('sales_review_counts').then((result) => result, () => ({ data: null })),
      ]);

      const failure = salesResult.error || movementsResult.error || expiryResult.error;
      if (failure) throw failure;

      const review = Array.isArray(reviewResult?.data) ? reviewResult.data[0] : null;
      const reviewNotices = [];
      // The count is part of the id, so a new held sale shows as unread again.
      if (Number(review?.held) > 0) {
        reviewNotices.push({
          id: `review:held:${review.held}`,
          kind: 'review',
          title: `${review.held} held sale${review.held === 1 ? '' : 's'} to approve`,
          detail: 'Sales the server rejected after the medicine was handed over',
          at: now.toISOString(),
          page: 'salesReview',
        });
      }
      if (Number(review?.to_check) > 0) {
        reviewNotices.push({
          id: `review:check:${review.to_check}`,
          kind: 'review',
          title: `${review.to_check} sale${review.to_check === 1 ? '' : 's'} to check`,
          detail: 'Recorded late, or uploaded by someone other than the cashier credited',
          at: now.toISOString(),
          page: 'salesReview',
        });
      }

      const notices = [
        ...(salesResult.data || []).map((sale) => ({
          id: `sale:${sale.id}`,
          kind: 'sale',
          title: 'Sale completed',
          detail: money.format(Number(sale.total_amount || 0)),
          at: sale.sold_at,
          page: 'salesReport',
        })),
        ...(movementsResult.data || []).map((movement) => {
          const transfer = movement.movement_type === 'transfer_in';
          return {
            id: `stock:${movement.id}`,
            kind: 'stock',
            title: transfer ? 'Stock transferred in' : 'New stock received',
            detail: `${movement.batches?.drugs?.name || 'Stock item'} · ${movement.quantity} units`,
            at: movement.created_at,
            page: 'stockedDrugs',
          };
        }),
        ...(expiryResult.data || []).map((batch) => {
          const expired = batch.expiry_date < today;
          return {
            id: `expiry:${batch.id}:${batch.expiry_date}`,
            kind: 'expiry',
            title: expired ? 'Expired stock needs write-off' : 'Expiry approaching',
            detail: `${batch.drugs?.name || 'Drug'} · batch ${batch.batch_number || '—'} · ${batch.quantity_remaining} units${expired ? '' : ` · ${new Date(`${batch.expiry_date}T00:00:00`).toLocaleDateString('en-KE')}`}`,
            at: `${batch.expiry_date}T00:00:00`,
            page: 'expiryReport',
          };
        }),
      ];

      notices.sort((a, b) => {
        if (a.kind === 'expiry' && b.kind === 'expiry') {
          const aExpired = a.title.startsWith('Expired');
          const bExpired = b.title.startsWith('Expired');
          if (aExpired !== bExpired) return aExpired ? -1 : 1;
          return new Date(a.at) - new Date(b.at);
        }
        return new Date(b.at) - new Date(a.at);
      });
      setItems([...reviewNotices, ...notices]);
    } catch (loadError) {
      setError(loadError.message || 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, [activeShopId]);

  useEffect(() => {
    if (!activeShopId) return undefined;
    loadNotifications();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadNotifications();
    }, 60_000);
    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible') loadNotifications();
    };
    document.addEventListener('visibilitychange', refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshOnFocus);
    };
  }, [activeShopId, dataVersion, loadNotifications]);

  const unreadCount = items.reduce((count, item) => count + (seenIds.has(item.id) ? 0 : 1), 0);

  function markAllRead() {
    const next = new Set([...seenIds, ...items.map((item) => item.id)]);
    setSeenIds(next);
    if (storageKey) {
      try { window.localStorage.setItem(storageKey, JSON.stringify([...next].slice(-300))); } catch { /* Storage may be disabled. */ }
    }
  }

  function openNotification(item) {
    if (!seenIds.has(item.id)) {
      const next = new Set([...seenIds, item.id]);
      setSeenIds(next);
      if (storageKey) {
        try { window.localStorage.setItem(storageKey, JSON.stringify([...next].slice(-300))); } catch { /* Storage may be disabled. */ }
      }
    }
    setOpen(false);
    if (availablePageKeys.includes(item.page)) onNavigatePage?.(item.page);
  }

  return (
    <div className="notification-control">
      <button
        className="notification-trigger"
        type="button"
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <IconBell size={20} stroke={1.8} aria-hidden="true" />
        {unreadCount > 0 && <span className="notification-count" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && <>
        <button className="notification-dismiss" type="button" aria-label="Close notifications" onClick={() => setOpen(false)} />
        <section className="notification-popover" role="dialog" aria-label="Notifications">
          <header className="notification-heading">
            <div><strong>Notifications</strong><span>{unreadCount ? `${unreadCount} unread` : 'All caught up'}</span></div>
            <button type="button" className="notification-icon-action" onClick={loadNotifications} aria-label="Refresh notifications" disabled={loading}>
              <IconRefresh size={17} stroke={1.8} className={loading ? 'is-spinning' : ''} />
            </button>
          </header>
          {unreadCount > 0 && <button className="notification-mark-read" type="button" onClick={markAllRead}><IconCheck size={15} /> Mark all read</button>}
          <div className="notification-list" aria-live="polite">
            {error ? <div className="notification-state notification-error">{error}</div>
              : loading && !items.length ? <div className="notification-state">Loading notifications…</div>
                : !items.length ? <div className="notification-state">No recent sales, receipts, or expiry alerts.</div>
                  : items.map((item) => {
                    const Icon = item.kind === 'sale' ? IconShoppingCart : item.kind === 'stock' ? IconPackageImport : IconAlertTriangle;
                    const unread = !seenIds.has(item.id);
                    return <button key={item.id} className={`notification-item${unread ? ' unread' : ''}`} type="button" onClick={() => openNotification(item)}>
                      <span className={`notification-item-icon ${item.kind}`}><Icon size={17} stroke={1.8} /></span>
                      <span className="notification-item-copy"><strong>{item.title}</strong><span>{item.detail}</span><small><IconClock size={13} /> {item.kind === 'expiry' || item.kind === 'review' ? 'Action needed' : relativeTime(item.at)}</small></span>
                      {unread && <span className="notification-unread-dot" aria-label="Unread" />}
                    </button>;
                  })}
          </div>
          <footer className="notification-footer">Updates are limited to the selected shop</footer>
        </section>
      </>}
    </div>
  );
}