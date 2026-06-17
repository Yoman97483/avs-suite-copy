const { Client } = require('pg');

const SOURCE_TABLES = [
  { name: 'employees', pk: ['id'] },
  { name: 'admins', pk: ['user_id'] },
  { name: 'clients', pk: ['id'] },
  { name: 'interventions', pk: ['id'] },
  { name: 'pointages', pk: ['id'] },
  { name: 'client_distances', pk: ['id'] },
  { name: 'admin_done_normalizations', pk: ['intervention_id'] },
  { name: 'interventions', pk: ['id'], secondPass: true },
];

const requiredEnv = [
  'SOURCE_PGHOST',
  'SOURCE_PGUSER',
  'SOURCE_PGPASSWORD',
  'TARGET_PGHOST',
  'TARGET_PGUSER',
  'TARGET_PGPASSWORD',
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function pgConfig(prefix) {
  return {
    host: process.env[`${prefix}_PGHOST`],
    port: Number(process.env[`${prefix}_PGPORT`] || 5432),
    user: process.env[`${prefix}_PGUSER`],
    password: process.env[`${prefix}_PGPASSWORD`],
    database: process.env[`${prefix}_PGDATABASE`] || 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

function q(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position
    `,
    [table]
  );
  return rows.map((row) => row.column_name);
}

async function upsertRows(target, table, pk, columns, rows) {
  if (rows.length === 0) return;

  const updateColumns = columns.filter((column) => !pk.includes(column));
  const assignments = updateColumns.map(
    (column) => `${q(column)} = excluded.${q(column)}`
  );
  const conflictAction =
    assignments.length > 0 ? `do update set ${assignments.join(', ')}` : 'do nothing';

  const batchSize = 100;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = [];
    const placeholders = batch.map((row, rowIndex) => {
      const rowPlaceholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });

    const sql = `
      insert into public.${q(table)} (${columns.map(q).join(', ')})
      values ${placeholders.join(', ')}
      on conflict (${pk.map(q).join(', ')}) ${conflictAction}
    `;

    await target.query(sql, values);
  }
}

async function transferTable(source, target, tableConfig) {
  const { name, pk, secondPass } = tableConfig;
  const columns = await getColumns(source, name);
  const { rows } = await source.query(
    `select ${columns.map(q).join(', ')} from public.${q(name)}`
  );

  await upsertRows(target, name, pk, columns, rows);

  const label = secondPass ? `${name} (second pass)` : name;
  console.log(`${label}: ${rows.length} rows transferred`);
}

async function main() {
  const source = new Client(pgConfig('SOURCE'));
  const target = new Client(pgConfig('TARGET'));

  await source.connect();
  await target.connect();

  try {
    await target.query('begin');
    for (const table of SOURCE_TABLES) {
      await transferTable(source, target, table);
    }
    await target.query('commit');
  } catch (error) {
    await target.query('rollback');
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
