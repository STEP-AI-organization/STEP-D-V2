import enum
from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


class JobStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class Job(Base):
    __tablename__ = "jobs"

    id = Column(String, primary_key=True, index=True)
    status = Column(Enum(JobStatus), default=JobStatus.pending, nullable=False, index=True)
    original_filename = Column(String, nullable=False)
    input_path = Column(String, nullable=False)
    duration = Column(Float, nullable=True)
    progress = Column(Integer, default=0, nullable=False)
    error = Column(Text, nullable=True)
    metadata_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    clips = relationship("Clip", back_populates="job", cascade="all, delete-orphan")


class Clip(Base):
    __tablename__ = "clips"

    id = Column(String, primary_key=True, index=True)
    job_id = Column(String, ForeignKey("jobs.id"), nullable=False, index=True)
    rank = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    score = Column(Integer, nullable=False)
    local_score = Column(Float, nullable=False)
    gemini_score = Column(Integer, nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    reason = Column(Text, nullable=False)
    video_url = Column(String, nullable=False)
    thumbnail_url = Column(String, nullable=False)
    thumbnail_text = Column(String, nullable=True)
    thumbnail_description = Column(Text, nullable=True)
    best_frame_time = Column(Float, nullable=True)
    transcript = Column(Text, nullable=False)
    evaluation_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    job = relationship("Job", back_populates="clips")


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    google_sub = Column(String, unique=True, nullable=False, index=True)
    email = Column(String, nullable=True, index=True)
    name = Column(String, nullable=True)
    picture_url = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class YouTubePublish(Base):
    __tablename__ = "youtube_publishes"

    id = Column(String, primary_key=True, index=True)
    clip_id = Column(String, ForeignKey("clips.id"), nullable=False, index=True)
    job_id = Column(String, ForeignKey("jobs.id"), nullable=False, index=True)
    status = Column(String, default="pending", nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    tags_json = Column(JSON, nullable=True)
    privacy_status = Column(String, default="private", nullable=False)
    category_id = Column(String, default="24", nullable=False)
    schedule_date = Column(String, nullable=True)
    youtube_video_id = Column(String, nullable=True)
    youtube_url = Column(String, nullable=True)
    error = Column(Text, nullable=True)
    metadata_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class YouTubeChannel(Base):
    __tablename__ = "youtube_channels"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    channel_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    thumbnail_url = Column(String, nullable=True)
    style_note = Column(Text, nullable=True)
    google_account_id = Column(String, nullable=True, index=True)
    google_account_email = Column(String, nullable=True)
    google_account_name = Column(String, nullable=True)
    google_account_picture_url = Column(String, nullable=True)
    access_token = Column(Text, nullable=False)
    refresh_token = Column(Text, nullable=True)
    token_type = Column(String, nullable=True)
    scope = Column(Text, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    is_default = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class YouTubeChannelDraft(Base):
    __tablename__ = "youtube_channel_drafts"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    access_token = Column(Text, nullable=False)
    refresh_token = Column(Text, nullable=True)
    token_type = Column(String, nullable=True)
    scope = Column(Text, nullable=True)
    token_expires_at = Column(DateTime, nullable=True)
    draft_expires_at = Column(DateTime, nullable=False, index=True)
    google_profile_json = Column(JSON, nullable=True)
    channels_json = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
