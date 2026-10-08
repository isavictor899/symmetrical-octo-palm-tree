import { supabase } from '../supabaseClient';

const POWERSYNC_URL = import.meta.env.VITE_POWERSYNC_URL;

export class Connector {
  async fetchCredentials() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session) {
      throw new Error('Not signed in — PowerSync needs an active Supabase session.');
    }
    if (!POWERSYNC_URL) {
      throw new Error('PowerSync endpoint not configured: ensure VITE_POWERSYNC_URL is set in your environment.');
    }

    return {
      endpoint: POWERSYNC_URL.replace(/\/+$/g, ''),
      token: session.access_token,
    };
  }

  // Transactional writes use the explicit local outbox in flush.js. Any
  // unexpected CRUD queue entries are logged and acknowledged here.
  async uploadData(database) {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;
    console.warn('[PowerSyncConnector] Unexpected CRUD operations; application transactions use the local outbox.', transaction.crud);
    await transaction.complete();
  }
}
