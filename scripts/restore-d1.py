"""Turn a nightly backup back into SQL.

    python scripts/restore-d1.py backup.json > restore.sql
    uv --directory backend run pywrangler d1 execute luma-ibon-cache --remote --file restore.sql

Reads the JSON that .github/workflows/backup.yml writes to R2 (ungzip it
first) and emits INSERT OR REPLACE statements. Existing rows with the same
primary key are overwritten; rows added since the backup are left alone, so a
restore never silently deletes newer data. Pass --replace-tables to clear each
table first when you want the database to match the backup exactly.
"""

import argparse
import gzip
import json
import sys
from pathlib import Path


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    # Single quotes are the only escape SQLite needs inside a string literal.
    return "'" + str(value).replace("'", "''") + "'"


def statements(table: str, rows: list[dict], clear: bool):
    if clear:
        yield f"DELETE FROM {table};"
    for row in rows:
        columns = ", ".join(row)
        values = ", ".join(sql_literal(value) for value in row.values())
        yield f"INSERT OR REPLACE INTO {table} ({columns}) VALUES ({values});"


def load(path: Path) -> dict:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path, help="backup.json or backup.json.gz")
    parser.add_argument("--table", action="append", help="restore only these tables")
    parser.add_argument(
        "--replace-tables",
        action="store_true",
        help="delete each table's rows first, so the result matches the backup exactly",
    )
    arguments = parser.parse_args()

    backup = load(arguments.backup)
    tables = backup.get("tables") or {}
    wanted = arguments.table or list(tables)

    missing = [table for table in wanted if table not in tables]
    if missing:
        print(f"backup has no table named {', '.join(missing)}", file=sys.stderr)
        return 1

    print(f"-- restored from {arguments.backup.name}, exported {backup.get('exportedAt', 'unknown')}")
    total = 0
    for table in wanted:
        rows = tables[table]
        total += len(rows)
        print(f"\n-- {table}: {len(rows)} rows")
        for statement in statements(table, rows, arguments.replace_tables):
            print(statement)

    print(f"{total} rows across {len(wanted)} tables", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
