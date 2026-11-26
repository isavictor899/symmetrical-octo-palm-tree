import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { PLAN_DEFAULTS, PLAN_LABELS } from './consoleShared';

const PLANS = ['basic', 'pro', 'enterprise'];

// What each plan includes. Owners switch features per plan; the change applies
// to every pharmacy on that plan straight away (on their next sync).
export function PlansFeatures({ isOwner, onChanged }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('platform_feature_matrix');
    if (rpcError) setError(rpcError.message);
    else { setRows(data || []); setError(''); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(plan, feature, enabled) {
    // Show the change at once; put it back if the server refuses it.
    const setCell = (value) => setRows((current) => current.map((row) => (row.key === feature ? { ...row, [plan]: value } : row)));
    setCell(enabled);
    setSaving(`${plan}:${feature}`);
    const { error: rpcError } = await supabase.rpc('platform_set_plan_feature', { p_plan: plan, p_feature: feature, p_enabled: enabled });
    setSaving('');
    if (rpcError) { setCell(!enabled); setError(rpcError.message); }
    else { setError(''); onChanged?.(`${PLAN_LABELS[plan]} plan updated.`); }
  }

  return (
    <section aria-label="Plans and features">
      <div className="section-header">
        <div>
          <h2>Plans &amp; features</h2>
          <p className="muted">What each plan includes. Sales, stock, receipts, barcodes, the cash register and supplier debts are in every plan.</p>
        </div>
      </div>
      {error ? <p className="console-banner danger">{error}</p> : null}
      <div className="table-wrap">
        <table className="console-matrix">
          <thead>
            <tr>
              <th>Feature</th>
              {PLANS.map((plan) => (
                <th key={plan}>
                  {PLAN_LABELS[plan]}
                  <div className="muted small console-matrix-limit">
                    {PLAN_DEFAULTS[plan].shops == null ? 'Unlimited shops & staff' : `${PLAN_DEFAULTS[plan].shops} shop${PLAN_DEFAULTS[plan].shops === 1 ? '' : 's'} · ${PLAN_DEFAULTS[plan].staff} staff`}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td><strong>{row.label}</strong><div className="muted small">{row.description}</div></td>
                {PLANS.map((plan) => (
                  <td key={plan}>
                    <label className="console-switch">
                      <input
                        type="checkbox"
                        checked={Boolean(row[plan])}
                        disabled={!isOwner || saving === `${plan}:${row.key}`}
                        onChange={(event) => toggle(plan, row.key, event.target.checked)}
                        aria-label={`${row.label} in ${PLAN_LABELS[plan]}`}
                      />
                      <span>{row[plan] ? 'Included' : 'Not included'}</span>
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Turning a feature off never deletes data: the pharmacy can still see what it recorded, it just cannot add more.
        Per-pharmacy exceptions are on each pharmacy&apos;s page.{isOwner ? '' : ' Only a console owner can change these.'}
      </p>
    </section>
  );
}

// Per-pharmacy exceptions: follow the plan, or force a feature on or off.
export function OrgFeatures({ orgId, isOwner, onChanged }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('platform_org_features', { p_org: orgId });
    if (rpcError) setError(rpcError.message);
    else { setRows(data || []); setError(''); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function change(feature, value) {
    setSaving(feature);
    const enabled = value === 'plan' ? null : value === 'on';
    const { error: rpcError } = await supabase.rpc('platform_set_org_feature', { p_org: orgId, p_feature: feature, p_enabled: enabled });
    setSaving('');
    if (rpcError) setError(rpcError.message);
    else { onChanged?.(''); load(); }
  }

  return (
    <div className="console-card console-features">
      <div className="console-card-head"><h3>Features</h3><span className="muted small">Exceptions to their plan</span></div>
      {error ? <p className="error small">{error}</p> : null}
      <ul className="console-feature-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span>
              <strong>{row.label}</strong>
              <span className={`console-feature-state ${row.enabled ? 'on' : 'off'}`}>{row.enabled ? 'On' : 'Off'}</span>
            </span>
            <select
              value={row.override == null ? 'plan' : row.override ? 'on' : 'off'}
              disabled={!isOwner || saving === row.key}
              onChange={(event) => change(row.key, event.target.value)}
              aria-label={`${row.label} for this pharmacy`}
            >
              <option value="plan">Follow plan ({row.plan_default ? 'on' : 'off'})</option>
              <option value="on">Always on</option>
              <option value="off">Always off</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}