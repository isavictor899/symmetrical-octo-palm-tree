import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PowerSyncContext } from '@powersync/react';
import {
  IconCash,
  IconCashRegister,
  IconChartBar,
  IconChevronDown,
  IconClipboardCheck,
  IconDashboard,
  IconFileText,
  IconHelpCircle,
  IconHistory,
  IconKey,
  IconLogout2,
  IconMenu2,
  IconPackageImport,
  IconPill,
  IconSearch,
  IconSettings,
  IconShoppingCart,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { supabase } from './lib/supabaseClient';
import { db, connector } from './lib/powersync/database';
import { flushAll } from './lib/powersync/flush';
import { ensureLocalStaff } from './lib/staff';
import { canManageStockedDrugs, canReceiveStock, isAdminRole } from './lib/roles';
import { defaultBrandColor, applyBrandTheme, applyCachedThemeIfAny, cacheTheme } from './lib/theme';
import { applyFontScale, loadFontScale } from './lib/fontScale';
import Login from './components/Login';
import PageErrorBoundary from './components/PageErrorBoundary';
import NotificationBell from './components/NotificationBell';
import ChangePassword from './components/ChangePassword';
import { clearRecentReceipts } from './lib/receipt';
import { cachedSubscription, fetchSubscription } from './lib/subscription';
import { SUPPORT } from './lib/support';
import SubscriptionBanner from './components/SubscriptionBanner';
import AnnouncementBar from './components/AnnouncementBar';
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
const StaffManagement = lazy(() => import('./components/StaffManagement'));
const Help = lazy(() => import('./components/Help'));
const SalesReview = lazy(() => import('./components/SalesReview'));
const PlatformConsole = lazy(() => import('./components/platform/PlatformConsole'));
// Shop details every page can use; the receipt fields are printed on receipts.
const SHOP_LIST_FIELDS = 'id, name, theme_color, location, phone, email, kra_pin, ppb_licence_no, receipt_footer, receipt_paper_width';


function NavIcon({ name }) {
  const icons = {
    dashboard: IconDashboard,
    sale: IconShoppingCart,
    salesReturns: IconHistory,
    salesReview: IconClipboardCheck,
    receive: IconPackageImport,
    purchaseOrders: IconFileText,
    stockedDrugs: IconPill,
    monthlyReport: IconChartBar,
    finance: IconCash,
    register: IconCashRegister,
    staff: IconUsers,
    settings: IconSettings,
    help: IconHelpCircle,
  };
  const Icon = icons[name];
  return Icon ? <Icon size={19} stroke={1.8} aria-hidden="true" focusable="false" /> : null;
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

// Pages that belong to a plan feature (see Plans & features in the console).
// The server refuses the writes too; hiding the page just avoids a dead end.
const PAGE_FEATURES = {
  purchaseOrders: 'purchase_orders',
  financeExpenses: 'finance',
  financeIncome: 'finance',
  financeTransactions: 'finance',
  monthlyReport: 'ai_insights',
  purchaseReport: 'advanced_reports',
  profitLoss: 'advanced_reports',
};

const pages = {
  dashboard: { label: 'Dashboard', icon: 'dashboard', component: Dashboard, group: 'Overview' },
  sale: { label: 'New sale', icon: 'sale', component: SaleEntry, group: 'Sales' },
  salesReturns: { label: 'Sales returns', icon: 'salesReturns', component: SaleEntry, group: 'Sales', props: { mode: 'return' } },
  salesReview: { label: 'Sales review', icon: 'salesReview', component: SalesReview, group: 'Sales' },
  stockedDrugs: { label: 'Stocked drugs', icon: 'stockedDrugs', component: StockedDrugs, group: 'Inventory' },
  receive: { label: 'Receive stock', icon: 'receive', component: ReceiveStock, group: 'Inventory' },
  purchaseOrders: { label: 'Purchase orders', icon: 'purchaseOrders', component: PurchaseOrders, group: 'Inventory' },
  financeExpenses: { label: 'Expenses', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'expenses' } },
  supplierDebts: { label: 'Supplier debts', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'debts' } },
  financeIncome: { label: 'Income', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'income' } },
  cashRegister: { label: 'Cash register', icon: 'register', component: Finance, group: 'Finance', props: { section: 'register' } },
  financeTransactions: { label: 'Transactions', icon: 'finance', component: Finance, group: 'Finance', props: { section: 'transactions' } },
  salesReport: { label: 'Sales report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'sales' } },
  purchaseReport: { label: 'Purchase report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'purchases' } },
  inventoryReport: { label: 'Inventory report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'inventory' } },
  expiryReport: { label: 'Expiry report', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'expiry' } },
  profitLoss: { label: 'Profit & loss', icon: 'monthlyReport', component: Reports, group: 'Reports', props: { section: 'profit' } },
  monthlyReport: { label: 'Monthly intelligence', icon: 'monthlyReport', component: MonthlyReport, group: 'Reports' },
  staff: { label: 'Staff', icon: 'staff', component: StaffManagement, group: 'System' },
  settings: { label: 'Settings', icon: 'settings', component: Settings, group: 'System' },
  help: { label: 'Help & support', icon: 'help', component: Help, group: 'System' },
};

export default function App() {
  const { showUpdateToast, refreshApp } = usePwaUpdateToast();
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [page, setPage] = useState('sale');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [staffName, setStaffName] = useState('');
  const [globalSearchText, setGlobalSearchText] = useState('');
  const [expandedNavGroups, setExpandedNavGroups] = useState(() => new Set(['Sales']));
  const [_visitedPages, setVisitedPages] = useState(() => new Set(['sale']));
  const [staffRole, setStaffRole] = useState(null);
  const [organizationShops, setOrganizationShops] = useState([]);
  const [activeShopId, setActiveShopId] = useState(null);
  const [saleSearchTerm, setSaleSearchTerm] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [accountInactive, setAccountInactive] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  // Enora Labs staff open the platform console instead of the POS. The server
  // checks platform_admins on every console call; this only picks the screen.
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [platformView, setPlatformView] = useState('console');
  const [subscription, setSubscription] = useState(null);
  const lastSessionUserId = useRef(null);
  const lastSetupUserId = useRef(null);
  // Loads the shops this user may see. Admins get every shop in their
  // organization; everyone else gets only their own shop.
  async function loadOrganizationShops(scope) {
    const query = supabase.from('shops').select(SHOP_LIST_FIELDS).order('name');
    const { data: shopsData, error: shopsError } = scope.admin && scope.organizationId
      ? await query.eq('organization_id', scope.organizationId)
      : await query.eq('id', scope.shopId);
    if (shopsError) {
      console.warn('[App] shops lookup warning:', shopsError.message);
      return;
    }
    setOrganizationShops(shopsData || []);
  }
  // Which shops this user may see: { admin, organizationId, shopId }. Kept so the
  // list can be reloaded after an admin adds or renames a shop in Settings.
  const shopScopeRef = useRef(null);

  // Apply a cached color instantly on first paint, before any network
  // call resolves — avoids a flash of the default color on every load.
  useEffect(() => {
    applyCachedThemeIfAny();
  }, []);

  useEffect(() => {
    applyFontScale(loadFontScale(session?.user?.id));
  }, [session?.user?.id]);

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
        setStaffName('');
        setOrganizationShops([]);
        setActiveShopId(null);
        shopScopeRef.current = null;
        // Shared tills: the next person must not see the last person's receipts.
        clearRecentReceipts();
        setMustChangePassword(false);
        setAccountInactive(false);
        setShowPasswordChange(false);
        setPlatformAdmin(false);
        setPlatformView('console');
        setSubscription(null);
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

        // Show the last known subscription straight away (offline tills).
        setSubscription(cachedSubscription(nextSession.user.id));

        const [{ data, error }, platformResult] = await Promise.all([
          supabase
            .from('staff')
            .select('role, full_name, shop_id, must_change_password, shops(name, theme_color, organization_id)')
            .eq('auth_user_id', nextSession.user.id)
            .maybeSingle(),
          supabase.rpc('platform_is_admin').then((result) => result, () => ({ data: false })),
        ]);
        const isPlatformAdmin = platformResult?.data === true;
        setPlatformAdmin(isPlatformAdmin);

        setStaffRole(data?.role || null);
        setStaffName(data?.full_name || '');
        setActiveShopId(data?.shop_id || null);
        setMustChangePassword(Boolean(data?.must_change_password));
        // A successful lookup that finds no staff row means this login was
        // deactivated (or never linked). A failed lookup (e.g. offline) is not
        // treated as deactivated, so an offline till keeps working.
        // An Enora Labs console login usually has no staff row; that is fine.
        setAccountInactive(!error && !data && !isPlatformAdmin);
        if (data) fetchSubscription(nextSession.user.id).then(setSubscription);

        if (error) {
          console.warn('[App] staff lookup warning:', error.message);
        }

        if (data?.shop_id) {
          shopScopeRef.current = {
            admin: isAdminRole(data.role),
            organizationId: data.shops?.organization_id,
            shopId: data.shop_id,
          };
          await loadOrganizationShops(shopScopeRef.current);
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
    const handleShopsChanged = () => {
      if (shopScopeRef.current) loadOrganizationShops(shopScopeRef.current);
    };
    window.addEventListener('pharmacy-pos:shops-changed', handleShopsChanged);
    return () => window.removeEventListener('pharmacy-pos:shops-changed', handleShopsChanged);
  }, []);

  // Pick up a renewal or suspension without signing out.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId || !staffRole) return undefined;
    const refresh = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) fetchSubscription(userId).then(setSubscription);
    };
    const timer = window.setInterval(refresh, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [session?.user?.id, staffRole]);

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
    if ((key === 'dashboard' || key === 'monthlyReport' || key === 'financeExpenses' || key === 'financeIncome' || key === 'financeTransactions' || key.endsWith('Report') || key === 'profitLoss') && !isAdminRole(staffRole)) return false;
    if ((key === 'receive' || key === 'purchaseOrders' || key === 'supplierDebts' || key === 'salesReturns') && !canReceiveStock(staffRole)) return false;
    if ((key === 'staff' || key === 'salesReview') && !isAdminRole(staffRole)) return false;
    if (key === 'stockedDrugs' && !canManageStockedDrugs(staffRole)) return false;
    // Unknown features (offline, never fetched) leave every page visible.
    if (PAGE_FEATURES[key] && Array.isArray(subscription?.features) && !subscription.features.includes(PAGE_FEATURES[key])) return false;
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
  const profileName = staffName || session?.user?.email || 'Staff member';
  const profileInitials = profileName.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'U';
  const profileRole = String(staffRole || 'Staff').replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  // Only pages this person may open; a page that becomes unavailable (role or
  // plan change) falls back to the first one they can use.
  const activePageEntry = availablePages.find(([key]) => key === page) || availablePages[0] || Object.entries(pages)[0];
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

  useEffect(() => {
    if (!profileMenuOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setProfileMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [profileMenuOpen]);

  function toggleNavGroup(group) {
    setExpandedNavGroups((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function submitGlobalSearch(event) {
    event.preventDefault();
    const term = globalSearchText.trim();
    if (!term) return;
    setSaleSearchTerm(term);
    navigateToPage('sale');
  }

  return (
    <PowerSyncContext.Provider value={db}>
      {authLoading ? (
        <div className="app-loading">Loading Pharmacy POS…</div>
      ) : recoveryMode ? (
        <Login recoveryMode onRecoveryComplete={() => setRecoveryMode(false)} />
      ) : !session ? (
        <Login />
      ) : platformAdmin && (platformView === 'console' || !staffRole) ? (
        <Suspense fallback={<div className="app-loading">Loading console…</div>}>
          <PlatformConsole email={session.user.email} onOpenPos={staffRole ? () => setPlatformView('pos') : null} />
        </Suspense>
      ) : subscription?.state === 'suspended' ? (
        <div className="login-page">
          <div className="login-card">
            <div className="login-brand">
              <span className="brand-mark"><IconPill size={20} stroke={2} aria-hidden="true" /></span>
              <span>Pharmacy POS</span>
            </div>
            <h1 className="login-title">Account suspended</h1>
            <p className="login-sub">
              This pharmacy&apos;s Pharmacy POS account has been suspended{subscription.suspended_reason ? `: ${subscription.suspended_reason}` : '.'}{' '}
              Your records are safe. To restore access, contact {SUPPORT.company} on {SUPPORT.phoneDisplay} or {SUPPORT.email}.
            </p>
            <button type="button" className="login-submit" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </div>
      ) : accountInactive ? (
        <div className="login-page">
          <div className="login-card">
            <div className="login-brand">
              <span className="brand-mark"><IconPill size={20} stroke={2} aria-hidden="true" /></span>
              <span>Pharmacy POS</span>
            </div>
            <h1 className="login-title">Account not active</h1>
            <p className="login-sub">This login is not linked to an active staff account. If you think this is a mistake, ask your pharmacy administrator.</p>
            <button type="button" className="login-submit" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </div>
      ) : mustChangePassword ? (
        <ChangePassword forced staffName={staffName} onDone={() => setMustChangePassword(false)} />
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
              <div className="brand"><span className="brand-mark"><IconPill size={20} stroke={2} aria-hidden="true" /></span><span>Pharmacy<br /><strong>POS</strong></span></div>
              <button className="drawer-close" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}>
                <IconX size={20} stroke={1.8} aria-hidden="true" />
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
            <div className="sidebar-footer"><span className="signed-in">Signed in</span><small>{session.user.email}</small><button className="sign-out" onClick={() => supabase.auth.signOut()}><IconLogout2 size={17} stroke={1.8} aria-hidden="true" /> Sign out</button></div>
          </aside>
          <header className="app-topbar">
            <button className="menu-toggle" type="button" aria-label="Open navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
              <IconMenu2 size={22} stroke={1.8} aria-hidden="true" />
            </button>
            <div className="topbar-context">
              <span className="mobile-app-name">Pharmacy POS</span>
              <span className="desktop-context-group">{activePageEntry?.[1]?.group || 'Workspace'}</span>
              <strong className="desktop-context-page">{activePageEntry?.[1]?.label || 'Dashboard'}</strong>
              {activeShop?.name && <small className="desktop-context-shop">{activeShop.name}</small>}
            </div>
            <form className="topbar-search" role="search" onSubmit={submitGlobalSearch}>
              <IconSearch size={18} stroke={1.8} aria-hidden="true" />
              <input value={globalSearchText} onChange={(event) => setGlobalSearchText(event.target.value)} placeholder="Search medicines…" aria-label="Search medicines and equipment" />
            </form>
            <NotificationBell activeShopId={activeShopId} userId={session.user.id} onNavigatePage={navigateToPage} availablePageKeys={availablePages.map(([key]) => key)} dataVersion={dataVersion} />
            <div className="profile-control">
              <button className="profile-trigger" type="button" aria-label={`Profile menu for ${profileName}`} aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}>
                <span className="profile-avatar" aria-hidden="true">{profileInitials}</span>
                <span className="profile-copy"><strong>{profileName}</strong><small>{profileRole}</small></span>
                <IconChevronDown size={16} stroke={1.8} aria-hidden="true" />
              </button>
              {profileMenuOpen && <>
                <button className="profile-menu-dismiss" type="button" aria-label="Close profile menu" onClick={() => setProfileMenuOpen(false)} />
                <div className="profile-menu" role="menu">
                  <div className="profile-menu-identity"><strong>{profileName}</strong><small>{session.user.email}</small><span>{profileRole}{activeShop?.name ? ` · ${activeShop.name}` : ''}</span></div>
                  {platformAdmin ? <button type="button" role="menuitem" className="profile-menu-neutral" onClick={() => { setProfileMenuOpen(false); setPlatformView('console'); }}><IconDashboard size={17} /> Enora Labs console</button> : null}
                  <button type="button" role="menuitem" className="profile-menu-neutral" onClick={() => { setProfileMenuOpen(false); setShowPasswordChange(true); }}><IconKey size={17} /> Change password</button>
                  <button type="button" role="menuitem" onClick={() => { setProfileMenuOpen(false); supabase.auth.signOut(); }}><IconLogout2 size={17} /> Sign out</button>
                </div>
              </>}
            </div>
          </header>
          <main className="app-content">
            <SubscriptionBanner subscription={subscription} isAdmin={isAdminRole(staffRole)} />
            <AnnouncementBar userId={session.user.id} />
            {ActivePageComponent ? (
              <div className="app-page-panel" aria-live="polite">
                <PageErrorBoundary key={page}>
                <Suspense fallback={<div className="app-page-loading">Loading page…</div>}>
                  <ActivePageComponent
                    {...(activePageEntry?.[1]?.props || {})}
                    {...(page === 'settings' ? { userId: session.user.id } : {})}
                    initialSearch={page === 'sale' ? saleSearchTerm : ''}
                    onNavigatePage={navigateToPage}
                    activeShopId={activeShopId}
                    activeShopName={activeShop?.name || ''}
                    activeShop={activeShop}
                    staffName={staffName}
                    organizationShops={organizationShops}
                    onActiveShopChange={setActiveShopId}
                    dataVersion={dataVersion}
                    staffRole={staffRole}
                    subscription={subscription}
                    isActive
                  />
                </Suspense>
                </PageErrorBoundary>
              </div>
            ) : null}
          </main>
          {showPasswordChange ? (
            <ChangePassword onDone={() => setShowPasswordChange(false)} onCancel={() => setShowPasswordChange(false)} />
          ) : null}
        </div>
      )}
    </PowerSyncContext.Provider>
  );
}