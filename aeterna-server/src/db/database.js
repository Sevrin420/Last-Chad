import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || './data/aeterna.db';

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const schemaPath = path.join(__dirname, '../../../02_Architecture/SQLite_Schema.sql');
// Fallback to local copy if needed
const localSchema = path.join(__dirname, 'schema.sql');
const schemaFile = fs.existsSync(localSchema) ? localSchema : schemaPath;

if (fs.existsSync(schemaFile)) {
  const schema = fs.readFileSync(schemaFile, 'utf8');
  db.exec(schema);
} else {
  console.warn('Schema file not found — tables may need manual creation');
}

export default db;
