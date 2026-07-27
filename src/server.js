import 'dotenv/config';
import { openDb, getSetting } from './db/index.js';
import { createApp } from './app.js';
import { generateInstances } from './services/schedule.js';

const db = openDb();
const app = createApp({ db });

// Materialize the rolling schedule at boot and daily thereafter.
if (getSetting(db, 'setup_complete', '0') === '1') {
  const created = generateInstances(db);
  if (created) console.log(`[schedule] materialized ${created} class instances`);
}
const daily = setInterval(() => {
  try {
    if (getSetting(db, 'setup_complete', '0') === '1') generateInstances(db);
  } catch (err) {
    console.error('[schedule] generator failed:', err.message);
  }
}, 24 * 3600000);
daily.unref();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Studio OS listening on http://localhost:${port}`);
  if (getSetting(db, 'setup_complete', '0') !== '1') {
    console.log(`First run: open http://localhost:${port}/setup to create your studio.`);
  }
});
