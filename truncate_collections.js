#!/usr/bin/env node
/**
 * Truncate (delete all documents) from one or more collections across one or more databases.
 *
 * Features:
 *  - Dry run by default (shows counts); use --yes (or --force) to execute deletions.
 *  - Lists of databases / collections passed via CLI flags (no external config file).
 *  - Optional confirmation prompt (skipped with --yes / --force).
 *  - Simple safety guard: refuse if any database name contains a forbidden substring provided via --blockSubstr.
 *  - Optional environment regex guard: --envVar NODE_ENV --envAllow "DEV|STAGE".
 *
 * Usage:
 *  Dry run (default):
 *    node truncate_collections.js --uri "$MONGODB_URI" --dbs db1,db2 --collections colA,colB
 *  Execute (skip prompt):
 *    node truncate_collections.js --uri "$MONGODB_URI" --dbs db1 --collections logs --yes
 *  With safety guards:
 *    node truncate_collections.js --uri "$MONGODB_URI" --dbs app_dev --collections sessions --envVar NODE_ENV --envAllow DEV --blockSubstr prod --yes
 */

// Timer function to measure execution time
function timer(label) {
  const start = Date.now();
  return {
    end: () => {
      const duration = Date.now() - start;
      console.log(`${label} took ${duration}ms`);
    },
  };
}
const { MongoClient } = require('mongodb');
const readline = require('readline');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        i++;
      }
    }
  }
  return parsed;
}

async function confirmPrompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function validateSafetyCli({ envVar, envAllow, blockSubstr }, dbs) {
  if (envVar && envAllow) {
    const val = process.env[envVar] || '';
    const re = new RegExp(envAllow);
    if (!re.test(val)) {
      throw new Error(
        `Environment guard failed: ${envVar}='${val}' does not match ${envAllow}`
      );
    }
  }
  if (blockSubstr) {
    for (const d of dbs) {
      if (d.includes(blockSubstr)) {
        throw new Error(
          `Database '${d}' contains forbidden substring '${blockSubstr}' (use different --blockSubstr or omit).`
        );
      }
    }
  }
}

async function truncateCollections(
  client,
  dbs,
  collections,
  { dryRun, blockSubstr }
) {
  if (!dbs.length) {
    console.log('No databases specified.');
    return { totalDeleted: 0, perCollection: [] };
  }
  if (!collections.length) {
    console.log('No collections specified.');
    return { totalDeleted: 0, perCollection: [] };
  }
  const perCollection = [];
  let totalDeleted = 0;
  for (const dbName of dbs) {
    if (blockSubstr && dbName.includes(blockSubstr)) {
      console.warn(
        `Skipping database '${dbName}' (blocked by '${blockSubstr}').`
      );
      continue;
    }
    const db = client.db(dbName);
    for (const collName of collections) {
      const collection = db.collection(collName);
      if (dryRun) {
        const count = await collection.estimatedDocumentCount();
        perCollection.push({
          database: dbName,
          collection: collName,
          deleted: 0,
          existing: count,
          dryRun: true,
        });
        console.log(
          `[DRY RUN] Would delete ${count} docs from ${dbName}.${collName}`
        );
        continue;
      }

      try {
        const res = await collection.deleteMany({});
        totalDeleted += res.deletedCount || 0;
        perCollection.push({
          database: dbName,
          collection: collName,
          deleted: res.deletedCount || 0,
        });
        console.log(
          `Deleted ${res.deletedCount || 0} docs from ${dbName}.${collName}`
        );
      } catch (err) {
        console.error(
          `Error deleting from ${dbName}.${collName}:`,
          err.message
        );
        perCollection.push({
          database: dbName,
          collection: collName,
          error: err.message,
        });
      }
    }
  }
  return { totalDeleted, perCollection };
}

(async function main() {
  const args = parseArgs();
  const uri = args.uri || process.env.MONGODB_URI;
  const yesFlag = args.yes || args.y;
  const force = args.force || false;
  const dryRun = !yesFlag && !force;
  const dbsArg = args.dbs || args.db;
  const colsArg = args.collections || args.collection || args.cols || args.col;
  const envVar = args.envVar;
  const envAllow = args.envAllow;
  const blockSubstr = args.blockSubstr;

  if (!uri) {
    console.error('Missing --uri or MONGODB_URI environment variable.');
    process.exit(1);
  }
  if (!dbsArg || !colsArg) {
    console.error(
      'Must supply --dbs (or --db) and --collections (or --collection).'
    );
    process.exit(1);
  }

  const normalizeList = (val) =>
    (Array.isArray(val) ? val.join(',') : String(val))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const dbs = normalizeList(dbsArg);
  const collections = normalizeList(colsArg);

  try {
    validateSafetyCli({ envVar, envAllow, blockSubstr }, dbs);
  } catch (e) {
    console.error('Safety validation failed:', e.message);
    process.exit(1);
  }

  console.log('Starting truncate utility');
  console.log('Dry run:', dryRun);
  console.log('Databases:', dbs.join(','));
  console.log('Collections:', collections.join(','));
  if (envVar && envAllow)
    console.log(
      `Env guard: ${envVar} must match /${envAllow}/ (actual='${
        process.env[envVar] || ''
      }')`
    );
  if (blockSubstr) console.log('Block substring:', blockSubstr);

  if (!dryRun && !force) {
    const confirmed = await confirmPrompt(
      'This will DELETE all documents in listed collections. Continue? (y/N): '
    );
    if (!confirmed) {
      console.log('Aborted by user.');
      process.exit(0);
    }
  }

  const client = new MongoClient(uri, { maxPoolSize: 5 });
  try {
    await client.connect();

    // Start timer only for execution mode (not dry run)
    const executionTimer = !dryRun ? timer('Collection truncation') : null;

    const result = await truncateCollections(client, dbs, collections, {
      dryRun,
      blockSubstr,
    });

    // End timer only for execution mode
    if (executionTimer) {
      executionTimer.end();
    }

    console.log('\nSummary:');
    if (dryRun) {
      for (const r of result.perCollection) {
        console.log(
          `  [DRY] ${r.database}.${r.collection} -> existing: ${r.existing}`
        );
      }
    } else {
      for (const r of result.perCollection) {
        if (r.error) {
          console.log(`  ERROR ${r.database}.${r.collection}: ${r.error}`);
        } else {
          console.log(
            `  Deleted ${r.deleted} from ${r.database}.${r.collection}`
          );
        }
      }
      console.log(`Total deleted: ${result.totalDeleted}`);
    }
    console.log('Done.');
  } catch (err) {
    console.error('Execution error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
})();
