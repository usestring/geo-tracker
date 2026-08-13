// Loads schema.sql and questions.csv into data/geo.db. Idempotent: questions
// upsert by id, so editing the CSV and re-running `make seed` is the whole
// question-bank workflow. Additions only, never silent removals - deactivate
// a question by setting active=0, or trend lines corrupt (hard rule).

import { Database } from "bun:sqlite";
import { BRAND_NAME } from "./brand.ts";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DB_PATH = join(ROOT, "data", "geo.db");

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.length > 0)) rows.push(row);
  return rows;
}

// data/ is gitignored, so a fresh clone does not have it yet.
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec(await Bun.file(join(ROOT, "schema.sql")).text());

const [header, ...rows] = parseCsv(await Bun.file(join(ROOT, "questions.csv")).text());
const col = (row: string[], name: string) => row[header.indexOf(name)];

const upsert = db.prepare(`
  INSERT INTO questions (id, text, intent, persona, brand, tags, active)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text, intent = excluded.intent, persona = excluded.persona,
    brand = excluded.brand, tags = excluded.tags, active = excluded.active
`);

const seedAll = db.transaction(() => {
  for (const row of rows) {
    upsert.run(
      Number(col(row, "id")),
      col(row, "text"),
      col(row, "intent"),
      col(row, "persona"),
      col(row, "brand") || BRAND_NAME.toLowerCase(),
      col(row, "tags"),
      Number(col(row, "active"))
    );
  }
});
seedAll();

const count = db.query("SELECT COUNT(*) AS n FROM questions WHERE active = 1").get() as { n: number };
console.log(`seeded ${rows.length} questions (${count.n} active) into ${DB_PATH}`);
