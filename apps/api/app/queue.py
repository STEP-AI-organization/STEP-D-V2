from collections.abc import Callable

from fastapi import BackgroundTasks


class BackgroundJobQueue:
    """Small queue adapter for MVP; swap this with Celery/RQ without changing routes."""

    def enqueue(self, background_tasks: BackgroundTasks, func: Callable[[str], None], job_id: str) -> None:
        background_tasks.add_task(func, job_id)


queue = BackgroundJobQueue()
