"""Magpie secrets provider: 1Password-backed with env-var fallback.

Provides a unified interface for resolving secrets from a provider:
- Primary backend: 1Password CLI (`op read "op://<vault>/<item>/<field>"`)
- Fallback: environment variables (`os.environ[key]`)
- Caching: TTL-based in-memory cache to avoid repeated CLI invocations

Design per QF-349: a single source of truth for secrets resolution that
can be swapped at the provider level without changing call sites.
Migration: existing env-var-bound configs become provider-resolved with
env-var fallback (nothing breaks if 1Password is unavailable).
"""

from __future__ import annotations

__version__ = "0.1.0"

from magpie_secrets.provider import (
    SecretResolutionError,
    SecretsProvider,
    create_secrets_provider,
    get_secrets_provider,
)

__all__ = [
    "SecretsProvider",
    "SecretResolutionError",
    "create_secrets_provider",
    "get_secrets_provider",
]
