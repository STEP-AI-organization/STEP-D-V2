from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.core.config import get_settings


settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")
connect_args = {"check_same_thread": False} if _is_sqlite else {}
# For a real DB (Cloud SQL Postgres), recycle and pre-ping pooled connections so
# in-process BackgroundTasks don't reuse a connection the server has dropped
# after an idle period. No-op semantics for sqlite.
engine_kwargs: dict = {"connect_args": connect_args, "future": True}
if not _is_sqlite:
    engine_kwargs.update(pool_pre_ping=True, pool_recycle=1800)
engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)
Base = declarative_base()


def _sqlite_columns(table_name: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    return {str(row[1]) for row in rows}


def _ensure_sqlite_column(table_name: str, column_name: str, column_type: str) -> None:
    if not settings.database_url.startswith("sqlite"):
        return
    columns = _sqlite_columns(table_name)
    if column_name in columns:
        return
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"))


def _migrate_sqlite_schema() -> None:
    if not settings.database_url.startswith("sqlite"):
        return
    _ensure_sqlite_column("youtube_channels", "google_account_id", "VARCHAR")
    _ensure_sqlite_column("youtube_channels", "google_account_email", "VARCHAR")
    _ensure_sqlite_column("youtube_channels", "google_account_name", "VARCHAR")
    _ensure_sqlite_column("youtube_channels", "google_account_picture_url", "VARCHAR")
    _ensure_sqlite_column("youtube_channels", "user_id", "VARCHAR")
    _ensure_sqlite_column("youtube_channels", "style_note", "TEXT")
    _ensure_sqlite_column("clips", "source_thumbnail_url", "VARCHAR")
    _ensure_sqlite_column("clips", "ppl_analysis_json", "JSON")


def init_db() -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_schema()



def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope():
    db: Session = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
