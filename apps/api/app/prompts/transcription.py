"""Default prompt for the OpenAI Whisper transcription pass.

Used as the default for ``Settings.openai_transcribe_prompt`` and can still be
overridden via the ``OPENAI_TRANSCRIBE_PROMPT`` environment variable.
"""

TRANSCRIPTION_PROMPT: str = (
    "Korean broadcast, variety show, interview, and talk show footage. "
    "Preserve names, places, proper nouns, exclamations, honorifics, and casual speech as spoken."
)
