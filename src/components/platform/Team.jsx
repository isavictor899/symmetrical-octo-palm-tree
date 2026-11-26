import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { ACTION_LABELS, callPlatformFunction, CredentialsModal, Field, formatDateTime, Modal } from './consoleShared';

const ROLE_HELP = {
  owner: 'Everything: payments, plans, suspensions, onboarding, announcements and the team.',
  support: 'View pharmacies, keep notes, send reminders, and reset a locked-out pharmacy owner\'s password. Cannot touch money, plans or suspensions.',
};

function AddMemberModal({ onClose, onDone }) {
  const [form, setForm] = useState({ full_name: '', email: '', role: 'support' });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    setWorking(true);
    setError('');
    try {
      const result = await callPlatformFunction({ action: 'add_team_member', ...form });
      onDone(result);
    } catch (addError) {
      setError(addError.message);
      setWorking(false);
    }
  }

  return (
    <Modal title="Add to the console team" onClose={onClose} onSubmit={submit} submitLabel="Add" working={working} error={error}>
      <Field label="Full name"><input required value={form.full_name} onChange={(event) => update('full_name', event.target.value)} /></Field>
      <Field label="Email"><input type="email" required value={form.email} onChange={(event) => update('email', event.target.value)} /></Field>
      <Field label="Role">
        <select value={form.role} onChange={(event) => update('role', event.target.value)}>
          <option value="support">Support</option>
          <option value="owner">Owner</option>
        </select>
      </Field>
      <p className="muted small">{ROLE_HELP[form.role]} If the email already has a login, it is reused. They must set up an authenticator app at first sign-in.</p>
    </Modal>
  );
}

export default function Team({ isOwner, onChanged }) {
  const [members, setMembers] = useState([]);
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [working, setWorking] = useState('');

  const load = useCallback(async () => {
    const [teamResult, activityResult] = await Promise.all([
      supabase.rpc('platform_team'),
      supabase.rpc('platform_team_activity'),
    ]);
    const failure = teamResult.error || activityResult.error;
    if (failure) setError(failure.message);
    else { setMembers(teamResult.data || []); setActivity(activityResult.data || []); setError(''); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(key, task, success) {
    setWorking(key);
    setError('');
    try {
      await task();
      onChanged?.(success);
      load();
    } catch (taskError) {
      setError(taskError.message);
    } finally {
      setWorking('');
    }
  }

  const rpcTask = (fn, args) => async () => {
    const { error: rpcError } = await supabase.rpc(fn, args);
    if (rpcError) throw rpcError;
  };

  return (
    <section aria-label="Console team">
      <div className="section-header">
        <div>
          <h2>Console team</h2>
          <p className="muted">People at Enora Labs who can use this console. Everyone must use an authenticator app.</p>
        </div>
        {isOwner ? <button type="button" className="save-button" onClick={() => setModal({ type: 'add' })}>Add member</button> : null}
      </div>
      {error ? <p className="console-banner danger">{error}</p> : null}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Member</th><th>Role</th><th>Authenticator</th><th>Last sign-in</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id}>
                <td><strong>{member.email}</strong>{member.is_you ? <span className="staff-you">You</span> : null}<div className="muted small">Added {formatDateTime(member.added_at)}</div></td>
                <td>
                  {isOwner && !member.is_you ? (
                    <select value={member.role} disabled={working === member.user_id}
                      onChange={(event) => run(member.user_id, rpcTask('platform_set_admin_role', { p_user: member.user_id, p_role: event.target.value }), 'Role changed.')}
                      aria-label={`Role for ${member.email}`}>
                      <option value="owner">Owner</option>
                      <option value="support">Support</option>
                    </select>
                  ) : <span className="console-role">{member.role === 'owner' ? 'Owner' : 'Support'}</span>}
                </td>
                <td>{member.mfa_enabled ? <span className="success">Set up</span> : <span className="error">Not yet</span>}</td>
                <td>{formatDateTime(member.last_sign_in_at)}</td>
                <td>
                  {isOwner && !member.is_you ? (
                    <div className="table-actions">
                      {member.mfa_enabled ? (
                        <button type="button" className="table-action" disabled={working === member.user_id}
                          onClick={() => setModal({ type: 'reset', member })}>Reset authenticator</button>
                      ) : null}
                      <button type="button" className="table-action danger" disabled={working === member.user_id}
                        onClick={() => setModal({ type: 'remove', member })}>Remove</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small"><strong>Owner:</strong> {ROLE_HELP.owner} <strong>Support:</strong> {ROLE_HELP.support}</p>

      <h3 className="console-section-title">Console activity</h3>
      {!activity.length ? <p className="review-empty">No activity yet.</p> : (
        <ol className="console-audit">
          {activity.map((entry, index) => (
            <li key={index}>
              <strong>{ACTION_LABELS[entry.action] || entry.action}</strong>
              {entry.organization ? <span> · {entry.organization}</span> : null}
              <span className="muted small"> · {formatDateTime(entry.created_at)}{entry.actor_email ? ` · ${entry.actor_email}` : ''}</span>
            </li>
          ))}
        </ol>
      )}

      {modal?.type === 'add' ? (
        <AddMemberModal onClose={() => setModal(null)} onDone={(result) => {
          load();
          if (result.temporary_password) setModal({ type: 'credentials', credentials: { ...result, title: `${result.email} can now sign in` } });
          else { setModal(null); onChanged?.(`${result.email} already had a login and is now on the team. They sign in with their usual password.`); }
        }} />
      ) : null}
      {modal?.type === 'credentials' ? <CredentialsModal credentials={modal.credentials} onClose={() => setModal(null)} /> : null}
      {modal?.type === 'remove' ? (
        <Modal title={`Remove ${modal.member.email} from the console?`} onClose={() => setModal(null)} danger submitLabel="Remove" working={working === modal.member.user_id}
          onSubmit={() => run(modal.member.user_id, rpcTask('platform_remove_admin', { p_user: modal.member.user_id }), 'Removed from the console team.').then(() => setModal(null))}>
          <p className="muted small">They lose console access straight away. Their login itself is kept, in case they are also pharmacy staff.</p>
        </Modal>
      ) : null}
      {modal?.type === 'reset' ? (
        <Modal title={`Reset ${modal.member.email}'s authenticator?`} onClose={() => setModal(null)} submitLabel="Reset" working={working === modal.member.user_id}
          onSubmit={() => run(modal.member.user_id, () => callPlatformFunction({ action: 'reset_member_mfa', user_id: modal.member.user_id }), 'Authenticator reset. They set up a new one at their next sign-in.').then(() => setModal(null))}>
          <p className="muted small">Use this when they have lost their phone. Confirm it is really them first, by phone or in person. They will set up a new authenticator at their next sign-in.</p>
        </Modal>
      ) : null}
    </section>
  );
}