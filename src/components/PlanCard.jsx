import { IconCheck, IconX } from '@tabler/icons-react';
import {
  CORE_FEATURES, daysUntil, formatNairobiDate, OPTIONAL_FEATURES, PLAN_NAMES, planStatusLine,
} from '../lib/subscription';
import { SUPPORT, whatsappLink } from '../lib/support';
import './PlanCard.css';

function usage(used, limit) {
  return limit == null ? `${used} (no limit)` : `${used} of ${limit}`;
}

// "Your plan" on the Settings page: plan, status, limits and what is included.
// Everyone can see it; only administrators get the renew / upgrade buttons.
export default function PlanCard({ subscription, isAdmin }) {
  if (!subscription) {
    return (
      <section className="plan-card" aria-labelledby="plan-heading">
        <h2 id="plan-heading">Your plan</h2>
        <p className="muted">Plan details load when this device is online.</p>
      </section>
    );
  }

  const planName = PLAN_NAMES[subscription.plan] || subscription.plan;
  const features = Array.isArray(subscription.features) ? subscription.features : [];
  const daysLeft = daysUntil(subscription.expires_at);
  const urgent = ['grace', 'read_only', 'suspended'].includes(subscription.state)
    || (['trial', 'active'].includes(subscription.state) && daysLeft !== null && daysLeft <= 7);

  return (
    <section className="plan-card" aria-labelledby="plan-heading">
      <div className="plan-card-head">
        <div>
          <p className="eyebrow">Your plan</p>
          <h2 id="plan-heading">{planName}</h2>
          <p className={`plan-status ${subscription.state}`}>{planStatusLine(subscription)}</p>
          {subscription.state === 'suspended' && subscription.suspended_reason ? <p className="plan-note">{subscription.suspended_reason}</p> : null}
        </div>
        {isAdmin ? (
          <div className="plan-actions">
            <a className={urgent ? 'plan-button primary' : 'plan-button'} target="_blank" rel="noreferrer"
              href={whatsappLink(`Hello Enora Labs, I would like to renew our Pharmacy POS ${planName} subscription.`)}>
              Renew on WhatsApp
            </a>
            <a className="plan-button" target="_blank" rel="noreferrer"
              href={whatsappLink(`Hello Enora Labs, we are on the Pharmacy POS ${planName} plan and would like to talk about upgrading.`)}>
              Ask about upgrading
            </a>
          </div>
        ) : null}
      </div>

      <dl className="plan-facts">
        <div><dt>Shops</dt><dd>{usage(subscription.shops_used, subscription.shop_limit)}</dd></div>
        <div><dt>Active staff</dt><dd>{usage(subscription.staff_used, subscription.staff_limit)}</dd></div>
        {subscription.expires_at ? (
          <div><dt>{subscription.state === 'trial' ? 'Trial ends' : 'Paid until'}</dt><dd>{formatNairobiDate(subscription.expires_at)}</dd></div>
        ) : null}
      </dl>

      <div className="plan-features">
        <h3>Included</h3>
        <ul>
          <li className="included"><IconCheck size={16} aria-hidden="true" /> {CORE_FEATURES}</li>
          {OPTIONAL_FEATURES.map(([key, label]) => {
            const included = features.includes(key);
            return (
              <li key={key} className={included ? 'included' : 'missing'}>
                {included ? <IconCheck size={16} aria-hidden="true" /> : <IconX size={16} aria-hidden="true" />}
                {label}{included ? '' : <span className="muted"> (not in your plan)</span>}
              </li>
            );
          })}
        </ul>
      </div>

      {isAdmin ? (
        <p className="muted small">
          To renew, upgrade or change your plan, contact {SUPPORT.company} on {SUPPORT.phoneDisplay} or {SUPPORT.email}. When your subscription ends,
          everything keeps working for 7 more days; after that the system becomes read-only until you renew. No data is ever deleted.
        </p>
      ) : (
        <p className="muted small">Your pharmacy&apos;s administrator manages the plan.</p>
      )}
    </section>
  );
}