import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PowerSyncContext } from '@powersync/react';
import { supabase } from './lib/supabaseClient';
import { db, connector } from './lib/powersync/database';
import { flushAll } from './lib/powersync/flush';
import { ensureLocalStaff } from './lib/staff';
import { canManageStockedDrugs, canReceiveStock, isAdminRole } from './lib/roles';
import { defaultBrandColor, applyBrandTheme, applyCachedThemeIfAny, cacheTheme } from './lib/theme';
import Login from './components/Login';
import PageErrorBoundary from './components/PageErrorBoundary';
import './App.css';

const Dashboard = lazy(() => import('./components/Dashboard'));
const SaleEntry = lazy(() => import('./components/SaleEntry'));
const ReceiveStock = lazy(() => import('./components/ReceiveStock'));
const PurchaseOrders = lazy(() => import('./components/PurchaseOrders'));
const StockedDrugs = lazy(() => import('./components/StockedDrugs'));
const MonthlyReport = lazy(() => import('./components/MonthlyReport'));
const Settings = lazy(() => import('./components/Settings'));
const Finance = lazy(() => import('./components/Finance'));
const Reports = lazy(() => import('./components/Reports'));


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
    case 'purchaseOrders':
      return <svg {...common}><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h4" /><path d="M9 11h6" /><path d="M9 15h6" /></svg>;
    case 'stockedDrugs':
      return <svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" focusable="false"><path d="M403.5 163.765 330.137 90.353h25.958c5.544 0 10.336-4.102 10.336-9.646V10.432C366.431 4.889 361.64 0 356.096 0H155.311c-5.544 0-9.743 4.889-9.743 10.432v70.275c0 5.544 4.199 9.646 9.743 9.646h25.958l-73.066 73.412c-1.882 1.882-2.792 4.632-2.792 7.295v331.294c0 5.544 4.199 9.646 9.743 9.646h281.098c5.544 0 10.336-4.102 10.336-9.646V171.06c0-2.663-1.206-5.413-3.088-7.295zM165.647 70.275V20.078h180.706v50.196H165.647zM386.51 371.451H245.961V250.98H386.51v120.471zm0-140.549H235.625c-5.544 0-9.743 4.889-9.743 10.432v140.549c0 5.544 4.199 9.646 9.743 9.646H386.51v100.392H125.49V175.218l84.175-84.865h92.076l84.768 84.865v55.684z" /><path d="M326.275 301.176v-30.117h-20.079v30.117h-30.118v20.079h30.118v30.118h20.079v-30.118h30.117v-20.079z" /></svg>;
    case 'monthlyReport':
      return <svg {...common}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 15v-4" /><path d="M12 15V8" /><path d="M16 15v-6" /></svg>;
    case 'finance':
      return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v10" /><path d="M15 9.5c0-1.1-1.3-2-3-2s-3 .9-3 2 1.3 2 3 2 3 .9 3 2-1.3 2-3 2-3-.9-3-2" /></svg>;
    case 'register':
      return <svg {...common}><path d="M4 8h16v11H4z" /><path d="M6 8V5h12v3" /><path d="M8 13h8" /><path d="M8 16h4" /></svg>;
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
  dashboard: { label: 'Dashboard', icon: 'dashboard', component: Dashboard, group: 'Overview' },
  sale: { label: 'Point of sale', icon: 'sale', component: SaleEntry, group: 'Sales' },
  stockedDrugs: { label: 'Stocked drugs', icon: 'stockedDrugs', component: StockedDrugs, group: 'Inventory' },
  receive: { label: 'Receive stock', icon: 'receive', component: ReceiveStock, group: 'Inventory' },
  purchaseOrders: { label: 'Purchase orders', icon: 'purchaseOrders', component: PurchaseOrders, group: 'Inventory' },
  financeExpenses: { label: 'Expenses', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'expenses' } },
  financeIncome: { label: 'Income', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'income' } },
  cashRegister: { label: 'Cash register', icon: 'register', component: Finance, group: 'Finance', props: { section: 'register' } },
  financeTransactions: { label: 'Transactions', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'transactions' } },
  salesReport: { label: 'Sales report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'sales' } },
  purchaseReport: { label: 'Purchase report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'purchases' } },
  inventoryReport: { label: 'Inventory report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'inventory' } },
  expiryReport: { label: 'Expiry report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'expiry' } },
  profitLoss: { label: 'Profit & loss', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'profit' } },
  monthlyReport: { label: 'Monthly intelligence', icon: 'monthlyReport', component: MonthlyReport, group: 'Reports' },
  settings: { label: 'Settings', icon: 'settings', component: Settings, group: 'System' },
};

export default function App() {
  const { showUpdateToast, refreshApp } = usePwaUpdateToast();
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [page, setPage] = useState('sale');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [expandedNavGroups, setExpandedNavGroups] = useState(() => new Set(['Sales']));
  const [_visitedPages, setVisitedPages] = useState(() => new Set(['sale']));
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
    if ((key === 'dashboard' || key === 'monthlyReport' || key === 'settings' || key === 'financeExpenses' || key === 'financeIncome' || key === 'financeTransactions' || key.endsWith('Report') || key === 'profitLoss') && !isAdminRole(staffRole)) return false;
    if ((key === 'receive' || key === 'purchaseOrders') && !canReceiveStock(staffRole)) return false;
    if (key === 'stockedDrugs' && !canManageStockedDrugs(staffRole)) return false;
    return true;
  });

  function navigateToPage(nextPage) {
    setPage(nextPage);
    setMobileMenuOpen(false);
    setVisitedPages((previous) => previous.has(nextPage)
      ? previous
      : new Set([...previous, nextPage]));
  }

  const activeShop = organizationShops.find((shop) => shop.id === activeShopId) || null;
  const activePageEntry = Object.entries(pages).find(([key]) => key === page) || Object.entries(pages)[0];
  const ActivePageComponent = activePageEntry?.[1]?.component;
  const navGroups = availablePages.reduce((groups, [key, item]) => {
    const group = item.group || 'Workspace';
    if (!groups[group]) groups[group] = [];
    groups[group].push([key, item]);
    return groups;
  }, {});

  useEffect(() => {
    const activeGroup = pages[page]?.group;
    if (!activeGroup) return;
    setExpandedNavGroups((previous) => new Set([...previous, activeGroup]));
  }, [page]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    document.body.classList.add('nav-drawer-open');
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.classList.remove('nav-drawer-open');
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileMenuOpen]);

  function toggleNavGroup(group) {
    setExpandedNavGroups((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

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
          {mobileMenuOpen && <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
          <aside className={`app-sidebar${mobileMenuOpen ? ' mobile-open' : ''}`} aria-label="Application navigation" role={mobileMenuOpen ? 'dialog' : undefined} aria-modal={mobileMenuOpen ? 'true' : undefined}>
            <div className="sidebar-brand-row">
              <div className="brand"><span className="brand-mark">+</span><span>Pharmacy<br /><strong>POS</strong></span></div>
              <button className="drawer-close" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <nav className="app-nav" aria-label="Main navigation">
              {Object.entries(navGroups).map(([group, entries]) => {
                const expandable = group !== 'Overview';
                const expanded = expandedNavGroups.has(group);
                if (!expandable) {
                  const [key, item] = entries[0];
                  return <button key={key} className={`nav-link${page === key ? ' active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => navigateToPage(key)}>
                    <span className="nav-icon"><NavIcon name={item.icon} /></span><span>{item.label}</span>
                  </button>;
                }
                const groupIcon = entries[0][1].icon;
                return <section className={`nav-group${expanded ? ' expanded' : ''}`} key={group}>
                  <button className="nav-group-toggle" type="button" aria-expanded={expanded} onClick={() => toggleNavGroup(group)}>
                    <span className="nav-icon"><NavIcon name={groupIcon} /></span><span>{group}</span>
                    <svg className="nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                  {expanded && <div className="nav-group-items">
                    {entries.map(([key, item]) => <button key={key} className={`nav-link${page === key ? ' active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => navigateToPage(key)}>
                      <span className="nav-icon"><NavIcon name={item.icon} /></span><span>{item.label}</span>
                    </button>)}
                  </div>}
                </section>;
              })}
            </nav>
            <div className="sidebar-footer"><span className="signed-in">Signed in</span><small>{session.user.email}</small><button className="sign-out" onClick={() => supabase.auth.signOut()}><PowerIcon /> Sign out</button></div>
          </aside>
          <header className="mobile-header">
            <button className="menu-toggle" type="button" aria-label="Open navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <strong>Pharmacy POS</strong>
            <button className="mobile-sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </header>
          <main className="app-content">
            {ActivePageComponent ? (
              <div className="app-page-panel" aria-live="polite">
                <PageErrorBoundary key={page}>
                <Suspense fallback={<div className="app-page-loading">Loading page…</div>}>
                  <ActivePageComponent
                    {...(activePageEntry?.[1]?.props || {})}
                    onNavigatePage={navigateToPage}
                    activeShopId={activeShopId}
                    activeShopName={activeShop?.name || ''}
                    organizationShops={organizationShops}
                    onActiveShopChange={setActiveShopId}
                    dataVersion={dataVersion}
                    staffRole={staffRole}
                    isActive
                  />
                </Suspense>
                </PageErrorBoundary>
              </div>
            ) : null}
          </main>
        </div>
      )}
    </PowerSyncContext.Provider>
  );
}

function PowerIcon() {
  return <svg className="power-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" /><path d="M7.2 5.8a8 8 0 1 0 9.6 0" /></svg>;
}
