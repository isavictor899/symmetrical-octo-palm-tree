import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAdminRole } from '../lib/roles';
import {
  callManageStaff,
  generateTemporaryPassword,
  MIN_PASSWORD_LENGTH,
  STAFF_ROLES,
} from '../lib/staffAdmin';
import './StaffManagement.css';

const EMPTY_FORM = { full_name: '', email: '', phone: '', role: 'cashier', shop_id: '', password: '' };

function roleLabel(value) {
  return STAFF_ROLES.find((role) => role.value === value)?.label || value || 'Unknown';
}

function formatDateTime(value) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusFor(member) {
  if (!member.is_active) return { label: 'Deactivated', className: 'staff-status inactive' };
  if (member.must_change_password) return { label: 'Must set password', className: 'staff-status pending' };
  return { label: 'Active', className: 'staff-status active' };
}

export default function StaffManagement({ organizationShops = [], activeShopId, staffRole }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [shopFilter, setShopFilter] = useState('all');

  const [formMode, setFormMode] = useState(null); // 'create' | 'edit' | null
  const [editingMember, setEditingMember] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [confirmAction, setConfirmAction] = useState(null); // { type: 'deactivate'|'reactivate'|'reset', member }
  const [credentials, setCredentials] = useState(null); // { name, email, password, reason }
  const [copied, setCopied] = useState(false);

  const canManage = isAdminRole(staffRole);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await callManageStaff('list');
      setStaff(data?.staff || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) loadStaff();
    else setLoading(false);
  }, [canManage, loadStaff]);

  const visibleStaff = useMemo(() => staff.filter((member) => {
    if (!showInactive && !member.is_active) return false;
    if (shopFilter !== 'all' && member.shop_id !== shopFilter) return false;
    return true;
  }), [staff, showInactive, shopFilter]);

  const inactiveCount = staff.filter((member) => !member.is_active).length;

  function updateForm(field, value) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  function openCreate() {
    setForm({
      ...EMPTY_FORM,
      shop_id: activeShopId || organizationShops[0]?.id || '',
      password: generateTemporaryPassword(),
    });
    setEditingMember(null);
    setFormError('');
    setMessage('');
    setFormMode('create');
  }

  function openEdit(member) {
    setForm({
      full_name: member.full_name || '',
      email: member.email || '',
      phone: member.phone || '',
      role: member.role,
      shop_id: member.shop_id,
      password: '',
    });
    setEditingMember(member);
    setFormError('');
    setMessage('');
    setFormMode('edit');
  }

  function closeForm(force = false) {
    if (saving && !force) return;
    setFormMode(null);
    setEditingMember(null);
    setForm(EMPTY_FORM);
    setFormError('');
  }

  async function submitForm(event) {
    event.preventDefault();
    if (saving) return;

    const fullName = form.full_name.trim();
    if (fullName.length < 2) return setFormError('Enter the staff member\'s full name.');
    if (!form.shop_id) return setFormError('Choose the shop they work in.');
    if (formMode === 'create') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) return setFormError('Enter a valid email address.');
      if (form.password.length < MIN_PASSWORD_LENGTH) {
        return setFormError(`The temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
    }

    setSaving(true);
    setFormError('');
    try {
      if (formMode === 'create') {
        await callManageStaff('create', {
          full_name: fullName,
          email: form.email.trim().toLowerCase(),
          phone: form.phone.trim(),
          role: form.role,
          shop_id: form.shop_id,
          password: form.password,
        });
        setCredentials({
          name: fullName,
          email: form.email.trim().toLowerCase(),
          password: form.password,
          reason: 'created',
        });
        setMessage(`${fullName} was added.`);
      } else {
        await callManageStaff('update', {
          staff_id: editingMember.id,
          full_name: fullName,
          phone: form.phone.trim(),
          role: form.role,
          shop_id: form.shop_id,
        });
        setMessage(`${fullName} was updated.`);
      }
      closeForm(true);
      await loadStaff();
    } catch (saveError) {
      setFormError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function runConfirmedAction() {
    if (!confirmAction || saving) return;
    const { type, member } = confirmAction;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      if (type === 'reset') {
        const password = generateTemporaryPassword();
        await callManageStaff('reset_password', { staff_id: member.id, password });
        setCredentials({ name: member.full_name, email: member.email, password, reason: 'reset' });
        setMessage(`A temporary password was set for ${member.full_name}.`);
      } else {
        const active = type === 'reactivate';
        await callManageStaff('set_active', { staff_id: member.id, active });
        setMessage(active
          ? `${member.full_name} can sign in again.`
          : `${member.full_name} was deactivated and can no longer sign in. Their past sales are kept.`);
      }
      setConfirmAction(null);
      await loadStaff();
    } catch (actionError) {
      setError(actionError.message);
      setConfirmAction(null);
    } finally {
      setSaving(false);
    }
  }

  async function copyCredentials() {
    if (!credentials) return;
    const lines = [
      `Pharmacy POS login for ${credentials.name}`,
      `Email: ${credentials.email}`,
      `Temporary password: ${credentials.password}`,
      'You will be asked to choose your own password when you first sign in.',
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  if (!canManage) {
    return <div className="page-panel"><p className="muted">Only an administrator can manage staff.</p></div>;
  }

  const selectedRole = STAFF_ROLES.find((role) => role.value === form.role);
  const editingSelf = formMode === 'edit' && editingMember?.is_self;

  return (
    <div className="page-panel">
      <div className="section-header">
        <div>
          <h2>Staff</h2>
          <p className="muted">Add staff, set what they can do, and remove access when someone leaves.</p>
        </div>
        <button type="button" className="save-button" onClick={openCreate}>Add staff member</button>
      </div>

      <div className="staff-toolbar">
        {organizationShops.length > 1 ? (
          <label>
            Shop
            <select value={shopFilter} onChange={(event) => setShopFilter(event.target.value)}>
              <option value="all">All shops</option>
              {organizationShops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
            </select>
          </label>
        ) : null}
        {inactiveCount > 0 ? (
          <label className="staff-toggle">
            <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
            Show deactivated ({inactiveCount})
          </label>
        ) : null}
      </div>

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {loading ? (
        <p className="muted">Loading staff...</p>
      ) : visibleStaff.length === 0 ? (
        <p className="muted">No staff to show.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Shop</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleStaff.map((member) => {
                const status = statusFor(member);
                return (
                  <tr key={member.id} className={member.is_active ? '' : 'staff-row-inactive'}>
                    <td>
                      <strong>{member.full_name}</strong>
                      {member.is_self ? <span className="staff-you">You</span> : null}
                      <div className="muted small">{member.email || 'No email'}</div>
                      {member.phone ? <div className="muted small">{member.phone}</div> : null}
                    </td>
                    <td>{roleLabel(member.role)}</td>
                    <td>{member.shop_name}</td>
                    <td><span className={status.className}>{status.label}</span></td>
                    <td className="small">{formatDateTime(member.last_sign_in_at)}</td>
                    <td>
                      <div className="table-actions">
                        {member.is_active ? (
                          <>
                            <button type="button" className="table-action" onClick={() => openEdit(member)}>Edit</button>
                            <button
                              type="button"
                              className="table-action"
                              onClick={() => setConfirmAction({ type: 'reset', member })}
                              disabled={member.is_self}
                              title={member.is_self ? 'Use Change password in your profile menu' : undefined}
                            >
                              Reset password
                            </button>
                            <button
                              type="button"
                              className="table-action danger"
                              onClick={() => setConfirmAction({ type: 'deactivate', member })}
                              disabled={member.is_self}
                              title={member.is_self ? 'You cannot deactivate yourself' : undefined}
                            >
                              Deactivate
                            </button>
                          </>
                        ) : (
                          <button type="button" className="table-action" onClick={() => setConfirmAction({ type: 'reactivate', member })}>
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {formMode ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal staff-modal" onSubmit={submitForm}>
            <div>
              <h3>{formMode === 'create' ? 'Add staff member' : `Edit ${editingMember?.full_name || 'staff member'}`}</h3>
              {formMode === 'create' ? (
                <p className="muted small">They will sign in with this email and the temporary password, then choose their own password.</p>
              ) : null}
            </div>

            <label className="classification-reason">
              Full name
              <input value={form.full_name} onChange={(event) => updateForm('full_name', event.target.value)} autoComplete="off" maxLength={80} required />
            </label>

            {formMode === 'create' ? (
              <label className="classification-reason">
                Email (used to sign in)
                <input type="email" value={form.email} onChange={(event) => updateForm('email', event.target.value)} autoComplete="off" required />
              </label>
            ) : (
              <p className="muted small">Sign-in email: {form.email || 'none'}</p>
            )}

            <label className="classification-reason">
              Phone (optional)
              <input type="tel" value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} placeholder="e.g. 0712 345 678" maxLength={20} />
            </label>

            <label className="classification-reason">
              Role
              <select value={form.role} onChange={(event) => updateForm('role', event.target.value)} disabled={editingSelf}>
                {STAFF_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </select>
              {selectedRole ? <span className="muted small">{selectedRole.help}</span> : null}
              {editingSelf ? <span className="muted small">You cannot change your own role.</span> : null}
            </label>

            <label className="classification-reason">
              Shop
              <select value={form.shop_id} onChange={(event) => updateForm('shop_id', event.target.value)} required>
                <option value="">Choose a shop</option>
                {organizationShops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
              </select>
            </label>

            {formMode === 'create' ? (
              <label className="classification-reason">
                Temporary password
                <div className="staff-password-row">
                  <input value={form.password} onChange={(event) => updateForm('password', event.target.value)} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
                  <button type="button" className="table-action" onClick={() => updateForm('password', generateTemporaryPassword())}>New</button>
                </div>
              </label>
            ) : null}

            {formError ? <p className="error">{formError}</p> : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => closeForm()} disabled={saving}>Cancel</button>
              <button type="submit" disabled={saving}>
                {saving ? 'Saving...' : formMode === 'create' ? 'Add staff member' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {confirmAction ? (
        <div className="modal-backdrop" role="presentation">
          <div className="classification-modal" role="dialog" aria-modal="true" aria-labelledby="staff-confirm-title">
            <div>
              <h3 id="staff-confirm-title">
                {confirmAction.type === 'deactivate' ? `Deactivate ${confirmAction.member.full_name}?`
                  : confirmAction.type === 'reactivate' ? `Reactivate ${confirmAction.member.full_name}?`
                    : `Reset password for ${confirmAction.member.full_name}?`}
              </h3>
              <p className="muted small">
                {confirmAction.type === 'deactivate'
                  ? 'They will be signed out and unable to sign in or record anything. Their past sales and records stay, with their name on them. You can reactivate them later.'
                  : confirmAction.type === 'reactivate'
                    ? 'They will be able to sign in again with their existing password, with the same role and shop.'
                    : 'Their current password will stop working. You will get a temporary password to give them, and they must choose a new one when they sign in.'}
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setConfirmAction(null)} disabled={saving}>Cancel</button>
              <button
                type="button"
                className={confirmAction.type === 'deactivate' ? 'danger-button' : undefined}
                onClick={runConfirmedAction}
                disabled={saving}
              >
                {saving ? 'Working...' : confirmAction.type === 'deactivate' ? 'Deactivate' : confirmAction.type === 'reactivate' ? 'Reactivate' : 'Reset password'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {credentials ? (
        <div className="modal-backdrop" role="presentation">
          <div className="classification-modal" role="dialog" aria-modal="true" aria-labelledby="staff-credentials-title">
            <div>
              <h3 id="staff-credentials-title">
                {credentials.reason === 'created' ? 'Login details' : 'Temporary password'}
              </h3>
              <p className="muted small">
                Give these to {credentials.name} privately. This password is shown only once. They will choose their own password when they first sign in.
              </p>
            </div>
            <dl className="staff-credentials">
              <dt>Email</dt>
              <dd>{credentials.email}</dd>
              <dt>Temporary password</dt>
              <dd><code>{credentials.password}</code></dd>
            </dl>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={copyCredentials}>{copied ? 'Copied' : 'Copy details'}</button>
              <button type="button" onClick={() => { setCredentials(null); setCopied(false); }}>Done</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}