import { daysUntil, formatNairobiDate, PLAN_NAMES } from '../lib/subscription';
import { SUPPORT, whatsappLink } from '../lib/support';

// Shown across the top of the POS. Admins get the detail and a way to pay;
// other staff are told to ask their administrator.
export default function SubscriptionBanner({ subscription, isAdmin }) {
  if (!subscription) return null;
  const { state, plan } = subscription;
  const daysLeft = daysUntil(subscription.expires_at);
  const contact = isAdmin ? (
    <a href={whatsappLink(`Hello Enora Labs, I would like to renew our Pharmacy POS ${PLAN_NAMES[plan] || ''} subscription.`)} target="_blank" rel="noreferrer">
      Renew: WhatsApp {SUPPORT.phoneDisplay}
    </a>
  ) : null;

  if (state === 'read_only') {
    return (
      <div className="subscription-banner danger" role="alert">
        <strong>Read-only.</strong>{' '}
        {isAdmin
          ? `Your subscription ended on ${formatNairobiDate(subscription.expires_at)}. You can view records and reports, but new sales and stock are paused until you renew.`
          : 'New sales and stock are paused because the subscription has expired. Ask your administrator to renew.'}
        {contact ? <> {contact}</> : null}
      </div>
    );
  }

  if (state === 'grace') {
    return (
      <div className="subscription-banner warning" role="status">
        <strong>Subscription expired.</strong>{' '}
        {isAdmin
          ? `It ended on ${formatNairobiDate(subscription.expires_at)}. Everything keeps working until ${formatNairobiDate(subscription.grace_ends_at)}, then the system becomes read-only.`
          : `Ask your administrator to renew before ${formatNairobiDate(subscription.grace_ends_at)}, or new sales will pause.`}
        {contact ? <> {contact}</> : null}
      </div>
    );
  }

  // Reminders a week ahead, for admins only.
  if (isAdmin && (state === 'trial' || state === 'active') && daysLeft !== null && daysLeft <= 7) {
    return (
      <div className="subscription-banner info" role="status">
        <strong>{state === 'trial' ? 'Free trial' : 'Subscription'} ends {daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}</strong>{' '}
        ({formatNairobiDate(subscription.expires_at)}). {contact}
      </div>
    );
  }

  return null;
}