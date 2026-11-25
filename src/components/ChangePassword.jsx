import { useState } from 'react';
import { IconPill } from '@tabler/icons-react';
import { supabase } from '../lib/supabaseClient';
import { callManageStaff, MIN_PASSWORD_LENGTH } from '../lib/staffAdmin';
import './StaffManagement.css';

// forced: shown full-screen after an admin created or reset this account.
// Otherwise it is a modal opened from the profile menu, with a Cancel button.
export default function ChangePassword({ forced = false, staffName = '', onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      await callManageStaff('change_own_password', { password });
      setPassword('');
      setConfirmPassword('');
      onDone?.();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  const fields = (
    <>
      <label className="field">
        <span>New password</span>
        <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      </label>
      {error ? <div className="login-error" role="alert">{error}</div> : null}
    </>
  );

  if (forced) {
    return (
      <div className="login-page">
        <form className="login-card password-change-card" onSubmit={submit}>
          <div className="login-brand">
            <span className="brand-mark"><IconPill size={20} stroke={2} aria-hidden="true" /></span>
            <span>Pharmacy POS</span>
          </div>
          <h1 className="login-title">Choose your password</h1>
          <p className="login-sub">
            {staffName ? `Welcome, ${staffName}. ` : ''}
            You signed in with a temporary password. Choose your own before you continue. Don&apos;t share it with anyone.
          </p>
          {fields}
          <button type="submit" className="login-submit" disabled={saving}>{saving ? 'Saving…' : 'Save password and continue'}</button>
          <button type="button" className="login-link" onClick={() => supabase.auth.signOut()} disabled={saving}>Sign out</button>
        </form>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="classification-modal" onSubmit={submit}>
        <div>
          <h3>Change password</h3>
          <p className="muted small">At least {MIN_PASSWORD_LENGTH} characters. You stay signed in on this device.</p>
        </div>
        {fields}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => onCancel?.()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </div>
  );
}