"""Secrets provider implementation."""

from __future__ import annotations

import logging
import os
import subprocess
import time
from abc import ABC, abstractmethod


class SecretResolutionError(Exception):
    """Raised when a secret cannot be resolved from any backend."""

    def __init__(self, key: str, reason: str) -> None:
        self.key = key
        self.reason = reason
        super().__init__(f"Failed to resolve secret '{key}': {reason}")


class SecretsProvider(ABC):
    """Abstract base for secrets providers."""

    @abstractmethod
    def resolve(self, key: str) -> str:
        """Resolve a secret synchronously.

        Args:
            key: The secret key (e.g., "SCHWAB_APP_KEY").

        Returns:
            The resolved secret value.

        Raises:
            SecretResolutionError: If the secret cannot be resolved.
        """
        ...

    @abstractmethod
    def clear(self) -> None:
        """Clear all cached entries."""
        ...


class _CachedSecretsProvider(SecretsProvider):
    """TTL-cached secrets provider with 1Password + env fallback."""

    DEFAULT_TTL_S = 5 * 60  # 5 minutes

    def __init__(self, ttl_s: float = DEFAULT_TTL_S) -> None:
        """Initialize the provider.

        Args:
            ttl_s: Cache TTL in seconds.
        """
        self._cache: dict[str, tuple[str, float]] = {}
        self._ttl_s = ttl_s

    def _get_cached(self, key: str) -> str | None:
        """Retrieve a value from cache if not expired."""
        if key not in self._cache:
            return None
        value, expires_at = self._cache[key]
        if time.time() > expires_at:
            del self._cache[key]
            return None
        return value

    def _set_cached(self, key: str, value: str) -> None:
        """Store a value in cache with TTL."""
        self._cache[key] = (value, time.time() + self._ttl_s)

    def _resolve_1password(self, key: str) -> str | None:
        """Try to resolve via 1Password CLI.

        Reads from OP_<key> env var for the op:// path.
        Returns None if path not set or op command fails.
        """
        op_path = os.environ.get(f"OP_{key}")
        if not op_path:
            return None

        try:
            result = subprocess.run(
                ["op", "read", op_path],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            )
            return result.stdout.strip()
        except (
            subprocess.CalledProcessError,
            FileNotFoundError,
            subprocess.TimeoutExpired,
        ) as e:
            # 1Password CLI not available or the secret path is invalid.
            # Log and fall through to env var fallback.
            logger = logging.getLogger(__name__)
            logger.error(f"1Password resolution failed for {key}: {e}")
            return None

    def _resolve_env(self, key: str) -> str | None:
        """Try to resolve from environment variable."""
        value = os.environ.get(key)
        return value if value else None

    def resolve(self, key: str) -> str:
        """Resolve a secret from 1Password or environment.

        Checks cache first, then tries 1Password, then env fallback.

        Args:
            key: The secret key.

        Returns:
            The resolved secret value.

        Raises:
            SecretResolutionError: If the secret cannot be resolved.
        """
        # Check cache first
        cached = self._get_cached(key)
        if cached is not None:
            return cached

        # Try 1Password first
        from_1pw = self._resolve_1password(key)
        if from_1pw:
            self._set_cached(key, from_1pw)
            return from_1pw

        # Fall back to environment variable
        from_env = self._resolve_env(key)
        if from_env:
            self._set_cached(key, from_env)
            return from_env

        # Neither source resolved the key
        raise SecretResolutionError(
            key,
            f"not found in 1Password (OP_{key}) or environment ({key})",
        )

    def clear(self) -> None:
        """Clear all cached entries."""
        self._cache.clear()


# ── Singleton instance ─────────────────────────────────────────────

_instance: SecretsProvider | None = None


def create_secrets_provider(
    ttl_s: float = _CachedSecretsProvider.DEFAULT_TTL_S,
) -> SecretsProvider:
    """Create a new secrets provider instance.

    Args:
        ttl_s: Cache TTL in seconds (default: 5 minutes).

    Returns:
        A new SecretsProvider instance.
    """
    return _CachedSecretsProvider(ttl_s=ttl_s)


def get_secrets_provider() -> SecretsProvider:
    """Get the singleton secrets provider.

    Creates one on first call. Reuses the same instance thereafter.

    Returns:
        The singleton SecretsProvider instance.
    """
    global _instance
    if _instance is None:
        _instance = create_secrets_provider()
    return _instance
