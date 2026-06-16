"""Reset local video/job data while preserving auth and channel records.

The script backs up the SQLite DB and moves old media folders under
apps/api/storage/backups before clearing jobs, clips, and YouTube publish rows.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


TABLES_TO_CLEAR = ("youtube_publishes", "clips", "jobs")
TABLES_TO_KEEP = ("users", "youtube_channels")
MEDIA_DIRS_TO_MOVE = ("jobs", "uploads")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def storage_dir(root: Path) -> Path:
    api_storage = root / "apps" / "api" / "storage"
    if (api_storage / "app.db").exists():
        return api_storage
    return root / "storage"


def table_exists(cursor: sqlite3.Cursor, table: str) -> bool:
    return cursor.execute("select 1 from sqlite_master where type='table' and name=?", (table,)).fetchone() is not None


def table_count(cursor: sqlite3.Cursor, table: str) -> int | None:
    if not table_exists(cursor, table):
        return None
    return int(cursor.execute(f"select count(*) from {table}").fetchone()[0])


def move_existing(path: Path, destination_root: Path) -> Path | None:
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        return None
    destination = destination_root / path.name
    if destination.exists():
        raise RuntimeError(f"Backup destination already exists: {destination}")
    shutil.move(str(path), str(destination))
    path.mkdir(parents=True, exist_ok=True)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description="Back up and reset local video/job DB data.")
    parser.add_argument("--apply", action="store_true", help="Actually mutate the DB and move media folders.")
    args = parser.parse_args()

    root = repo_root()
    store = storage_dir(root)
    db_path = store / "app.db"
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    con = sqlite3.connect(db_path)
    cursor = con.cursor()
    before = {table: table_count(cursor, table) for table in (*TABLES_TO_CLEAR, *TABLES_TO_KEEP)}

    print(f"DB: {db_path}")
    print("Before:")
    for table, count in before.items():
      print(f"  {table}: {'missing' if count is None else count}")

    media_counts = {
        name: len([item for item in (store / name).iterdir() if item.is_dir()]) if (store / name).exists() else 0
        for name in MEDIA_DIRS_TO_MOVE
    }
    print("Media directories:")
    for name, count in media_counts.items():
        print(f"  {name}: {count}")

    if not args.apply:
        print("Dry run only. Re-run with --apply to reset.")
        con.close()
        return

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = store / "backups" / stamp
    backup_root.mkdir(parents=True, exist_ok=False)
    db_backup = backup_root / "app.db"
    shutil.copy2(db_path, db_backup)

    con.execute("pragma foreign_keys=ON")
    for table in TABLES_TO_CLEAR:
        if table_exists(cursor, table):
            cursor.execute(f"delete from {table}")
    con.commit()
    after = {table: table_count(cursor, table) for table in (*TABLES_TO_CLEAR, *TABLES_TO_KEEP)}
    con.close()

    moved: list[Path] = []
    media_backup_root = backup_root / "media"
    media_backup_root.mkdir(parents=True, exist_ok=True)
    for name in MEDIA_DIRS_TO_MOVE:
        moved_path = move_existing(store / name, media_backup_root)
        if moved_path is not None:
            moved.append(moved_path)

    print("Backups:")
    print(f"  db: {db_backup}")
    for path in moved:
        print(f"  media: {path}")
    print("After:")
    for table, count in after.items():
        print(f"  {table}: {'missing' if count is None else count}")


if __name__ == "__main__":
    main()
