from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.auth import router as auth_router
from app.api.routes import router
from app.api.youtube import router as youtube_router
from app.core.config import get_settings
from app.core.database import init_db


def create_app() -> FastAPI:
    settings = get_settings()
    init_db()

    app = FastAPI(title=settings.app_name)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(auth_router)
    app.include_router(youtube_router)
    app.mount("/media", StaticFiles(directory=settings.storage_dir), name="media")
    return app


app = create_app()
