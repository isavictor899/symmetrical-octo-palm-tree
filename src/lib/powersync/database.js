import { PowerSyncDatabase } from '@powersync/web';
import { AppSchema } from './schema';
import { Connector } from './PowerSyncConnector';

export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: {
    dbFilename: 'pharmacy-pos.sqlite',
  },
});

export const connector = new Connector();
