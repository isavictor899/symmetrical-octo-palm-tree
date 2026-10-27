import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PowerSyncContext } from '@powersync/react';
import { supabase } from './lib/supabaseClient';
import { db, connector } from './lib/powersync/database';
import { flushAll } from './lib/powersync/flush';
import { ensureLocalStaff } from './lib/staff';
import { canManageStockedDrugs, canReceiveStock, isAdminRole } from './lib/roles';
import { defaultBrandColor, applyBrandTheme, applyCachedThemeIfAny, cacheTheme } from './lib/theme';
import Login from './components/Login';
import './App.css';

const Dashboard = lazy(() => import('./components/Dashboard'));
const SaleEntry = lazy(() => import('./components/SaleEntry'));
const ReceiveStock = lazy(() => import('./components/ReceiveStock'));
const StockedDrugs = lazy(() => import('./components/StockedDrugs'));
const MonthlyReport = lazy(() => import('./components/MonthlyReport'));
const Settings = lazy(() => import('./components/Settings'));


function NavIcon({ name }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };

  switch (name) {
    case 'dashboard':
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case 'sale':
      return <svg {...common} strokeWidth={1.6}><rect x="6.5" y="4.5" width="11" height="15" rx="1.5" /><rect x="8.5" y="6.5" width="7" height="5" /><path d="M8.5 17.5H9.5" /><path d="M14.5 17.5H15.5" /><path d="M11.5 17.5H12.5" /><path d="M8.5 15.5H9.5" /><path d="M14.5 15.5H15.5" /><path d="M11.5 15.5H12.5" /><path d="M8.5 13.5H9.5" /><path d="M14.5 13.5H15.5" /><path d="M11.5 13.5H12.5" /></svg>;
    case 'receive':
      return <svg {...common}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 19h14" /><path d="M7 19v-3" /><path d="M17 19v-3" /></svg>;
    case 'stockedDrugs':
      return <svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" focusable="false"><path d="M403.5 163.765 330.137 90.353h25.958c5.544 0 10.336-4.102 10.336-9.646V10.432C366.431 4.889 361.64 0 356.096 0H155.311c-5.544 0-9.743 4.889-9.743 10.432v70.275c0 5.544 4.199 9.646 9.743 9.646h25.958l-73.066 73.412c-1.882 1.882-2.792 4.632-2.792 7.295v331.294c0 5.544 4.199 9.646 9.743 9.646h281.098c5.544 0 10.336-4.102 10.336-9.646V171.06c0-2.663-1.206-5.413-3.088-7.295zM165.647 70.275V20.078h180.706v50.196H165.647zM386.51 371.451H245.961V250.98H386.51v120.471zm0-140.549H235.625c-5.544 0-9.743 4.889-9.743 10.432v140.549c0 5.544 4.199 9.646 9.743 9.646H386.51v100.392H125.49V175.218l84.175-84.865h92.076l84.768 84.865v55.684z" /><path d="M326.275 301.176v-30.117h-20.079v30.117h-30.118v20.079h30.118v30.118h20.079v-30.118h30.117v-20.079z" /></svg>;
    case 'monthlyReport':
      return <svg {...common}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 15v-4" /><path d="M12 15V8" /><path d="M16 15v-6" /></svg>;
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M4.93 4.93l2.12 2.12" /><path d="m16.95 16.95 2.12 2.12" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="m4.93 19.07 2.12-2.12" /><path d="m16.95 7.05 2.12-2.12" /></svg>;
    default:
      return null;
  }
}

function usePwaUpdateToast() {
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    const handleNewServiceWorker = () => {
      setShowUpdateToast(true);
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleNewServiceWorker);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleNewServiceWorker);
    };
  }, []);

  const refreshApp = () => {
    window.location.reload();
  };

  return { showUpdateToast, refreshApp };
}

const pages = {
  dashboard: { label: 'Dashboard', icon: 'dashboard', component: Dashboard },
  sale: { label: 'New sale', icon: 'sale', component: SaleEntry },
  receive: { label: 'Receive stock', icon: 'receive', component: ReceiveStock },
  stockedDrugs: { label: 'Stocked drugs', icon: 'stockedDrugs', component: StockedDrugs },
  monthlyReport: { label: 'Monthly report', icon: 'monthlyReport', component: MonthlyReport },
  settings: { label: 'Settings', icon: 'settings', component: Settings },
};

export default function App() {
  const { showUpdateToast, refreshApp } = usePwaUpdateToast();
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [page, setPage] = useState('sale');
  const [visitedPages, setVisitedPages] = useState(() => new Set(['sale']));
  const [staffRole, setStaffRole] = useState(null);
  const [organizationShops, setOrganizationShops] = useState([]);
  const [activeShopId, setActiveShopId] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const lastSessionUserId = useRef(null);
  const lastSetupUserId = useRef(null);

  // Apply a cached color instantly on first paint, before any network
  // call resolves — avoids a flash of the default color on every load.
  useEffect(() => {
    applyCachedThemeIfAny();
  }, []);

  useEffect(() => {
    if (!session) {
      lastSessionUserId.current = null;
      setPage('sale');
      return;
    }

    // Wait until the role lookup finishes before choosing the landing page.
    if (!staffRole) return;
    if (lastSessionUserId.current === session.user.id) {
      return;
    }

    lastSessionUserId.current = session.user.id;
    const initialPage = isAdminRole(staffRole) ? 'dashboard' : 'sale';
    setPage(initialPage);
    setVisitedPages((previous) => new Set([...previous, initialPage]));
  }, [session, staffRole]);

  useEffect(() => {
    async function setSessionAndRole(nextSession) {
      setSession(nextSession);
      if (!nextSession) {
        lastSetupUserId.current = null;
        setStaffRole(null);
        setOrganizationShops([]);
        setActiveShopId(null);
        setVisitedPages(new Set(['sale']));
        applyBrandTheme(defaultBrandColor);
        // Signed out — stop syncing AND wipe local data, so a different
        // user logging in on this same device doesn't inherit stale
        // buckets from the previous session.
        db.disconnectAndClear({ clearLocal: false }).catch((err) => console.error('PowerSync disconnectAndClear failed:', err));
        setAuthLoading(false);
      } else {
        if (lastSetupUserId.current === nextSession.user.id) {
          setAuthLoading(false);
          return;
        }
        lastSetupUserId.current = nextSession.user.id;
        // The session is known from local storage, so release the app shell now.
        // Role and shop lookups below run in the background; they no longer
        // hold the whole app behind two sequential network round trips.
        setAuthLoading(false);

        // Start syncing while the staff/role lookup is in flight, rather than
        // making the page wait for those two network operations in sequence.
        db.connect(connector, { checkpointMode: 'requests' })
          .then(() => flushAll(db))
          .catch((err) => console.error('PowerSync connect failed:', err));

        const { data, error } = await supabase
          .from('staff')
          .select('role, shop_id, shops(name, theme_color, organization_id)')
          .eq('auth_user_id', nextSession.user.id)
          .maybeSingle();

        setStaffRole(data?.role || null);
        setActiveShopId(data?.shop_id || null);

        if (error) {
          console.warn('[App] staff lookup warning:', error.message);
        }

        if (data?.shop_id) {
          const admin = isAdminRole(data.role);
          const organizationId = data.shops?.organization_id;
          const shopsQuery = admin && organizationId
            ? supabase.from('shops').select('id, name, theme_color').eq('organization_id', organizationId).order('name')
            : supabase.from('shops').select('id, name, theme_color').eq('id', data.shop_id).order('name');
          const { data: shopsData, error: shopsError } = await shopsQuery;
          if (shopsError) {
            console.warn('[App] shops lookup warning:', shopsError.message);
          } else {
            setOrganizationShops(shopsData || []);
          }
        }

        // Apply this shop's real saved color (falls back to default if
        // none is set yet), and cache it so the next load can paint it
        // instantly before this query resolves.
        const themeColor = data?.shops?.theme_color || defaultBrandColor;
        applyBrandTheme(themeColor);
        cacheTheme(themeColor);

        // Do not hold the app shell behind the initial PowerSync connection.
        // The pages can render immediately and their local queries update as
        // PowerSync syncs in the background.
        // Ensure the user's staff row exists locally (fetching it from
        // Supabase if this device has never synced), so the sales screen can
        // resolve the shop immediately. Never throws.
        ensureLocalStaff(db, nextSession.user.id);
      }
      setAuthLoading(false);
    }
    supabase.auth.getSession().then(({ data }) => setSessionAndRole(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') setRecoveryMode(false);
      setSessionAndRole(nextSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const handleDataChanged = () => setDataVersion((version) => version + 1);
    window.addEventListener('pharmacy-pos:data-changed', handleDataChanged);
    return () => window.removeEventListener('pharmacy-pos:data-changed', handleDataChanged);
  }, []);

  useEffect(() => {
    if (!session) return undefined;

    const flush = () => { flushAll(db); };
    flush();
    window.addEventListener('online', flush);
    const interval = window.setInterval(flush, 15000);
    return () => {
      window.removeEventListener('online', flush);
      window.clearInterval(interval);
    };
  }, [session]);

  useEffect(() => {
    const activeShop = organizationShops.find((shop) => shop.id === activeShopId);
    if (!activeShop) return;
    const themeColor = activeShop.theme_color || defaultBrandColor;
    applyBrandTheme(themeColor);
    cacheTheme(themeColor);
  }, [activeShopId, organizationShops]);

  const availablePages = Object.entries(pages).filter(([key]) => {
    if ((key === 'dashboard' || key === 'monthlyReport' || key === 'settings') && !isAdminRole(staffRole)) return false;
    if (key === 'receive' && !canReceiveStock(staffRole)) return false;
    if (key === 'stockedDrugs' && !canManageStockedDrugs(staffRole)) return false;
    return true;
  });

  function navigateToPage(nextPage) {
    setPage(nextPage);
    setVisitedPages((previous) => previous.has(nextPage)
      ? previous
      : new Set([...previous, nextPage]));
  }

  const activeShop = organizationShops.find((shop) => shop.id === activeShopId) || null;
  const activePageEntry = Object.entries(pages).find(([key]) => key === page) || Object.entries(pages)[0];
  const ActivePageComponent = activePageEntry?.[1]?.component;

  return (
    <PowerSyncContext.Provider value={db}>
      {authLoading ? (
        <div className="app-loading">Loading Pharmacy POS…</div>
      ) : recoveryMode ? (
        <Login recoveryMode onRecoveryComplete={() => setRecoveryMode(false)} />
      ) : !session ? (
        <Login />
      ) : (
        <div className="app-shell">
          {showUpdateToast && (
            <div className="app-update-toast" role="alert">
              <div>
                <strong>App updated</strong>
                <span>Refresh now to use the latest version.</span>
              </div>
              <button type="button" onClick={refreshApp}>Refresh now</button>
            </div>
          )}
          <aside className="app-sidebar">
            <div className="brand"><span className="brand-mark">+</span><span>Pharmacy<br /><strong>POS</strong></span></div>
            <nav className="app-nav" aria-label="Main navigation">
              {availablePages.map(([key, item]) => <button key={key} className={page === key ? 'active' : ''} onClick={() => navigateToPage(key)}>
                <span className="nav-icon"><NavIcon name={item.icon} /></span>{item.label}
              </button>)}
            </nav>
            <div className="sidebar-footer"><span className="signed-in">Signed in</span><small>{session.user.email}</small><button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
          </aside>
          <header className="mobile-header"><span className="brand-mark">+</span><strong>Pharmacy POS</strong><button onClick={() => supabase.auth.signOut()}>Sign out</button></header>
          <main className="app-content">
            {ActivePageComponent ? (
              <div className="app-page-panel" aria-live="polite">
                <Suspense fallback={<div className="app-page-loading">Loading page…</div>}>
                  <ActivePageComponent
                    activeShopId={activeShopId}
                    activeShopName={activeShop?.name || ''}
                    organizationShops={organizationShops}
                    onActiveShopChange={setActiveShopId}
                    dataVersion={dataVersion}
                    isActive
                  />
                </Suspense>
              </div>
            ) : null}
          </main>
          <nav className="mobile-nav" aria-label="Main navigation">
            {availablePages.map(([key, item]) => <button key={key} className={page === key ? 'active' : ''} onClick={() => navigateToPage(key)}><span className="nav-icon"><NavIcon name={item.icon} /></span>{item.label}</button>)}
          </nav>
        </div>
      )}
    </PowerSyncContext.Provider>
  );
}
