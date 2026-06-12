"""Tests for the secrets provider."""

from __future__ import annotations

import os
import subprocess
from unittest.mock import Mock, patch

import pytest
from magpie_secrets.provider import (
    SecretResolutionError,
    _CachedSecretsProvider,
    create_secrets_provider,
    get_secrets_provider,
)


@pytest.fixture
def provider():
    """Create a fresh provider for each test."""
    p = create_secrets_provider()
    yield p
    p.clear()
    # Clean up env vars
    for key in ["TEST_SECRET", "OP_TEST_SECRET", "ANOTHER_SECRET", "OP_ANOTHER_SECRET"]:
        os.environ.pop(key, None)


class TestSecretsProviderResolve:
    """Tests for the resolve() method."""

    def test_resolves_from_environment(self, provider):
        """Test that secrets are resolved from environment variables."""
        os.environ["TEST_SECRET"] = "env-value"
        assert provider.resolve("TEST_SECRET") == "env-value"

    def test_raises_when_secret_not_found(self, provider):
        """Test that SecretResolutionError is raised for missing secrets."""
        with pytest.raises(SecretResolutionError) as exc_info:
            provider.resolve("NONEXISTENT_SECRET")
        assert exc_info.value.key == "NONEXISTENT_SECRET"

    def test_caches_env_var_results(self, provider):
        """Test that environment variable results are cached."""
        os.environ["TEST_SECRET"] = "env-value-1"
        result1 = provider.resolve("TEST_SECRET")
        # Change env var; cache should still return original
        os.environ["TEST_SECRET"] = "different-value"
        result2 = provider.resolve("TEST_SECRET")

        assert result1 == "env-value-1"
        assert result2 == "env-value-1"  # Cached value

    @patch("subprocess.run")
    def test_resolves_from_1password(self, mock_run, provider):
        """Test that secrets are resolved from 1Password CLI."""
        os.environ["OP_TEST_SECRET"] = "op://vault/item/field"
        mock_run.return_value = Mock(stdout="1password-value\n", returncode=0)

        result = provider.resolve("TEST_SECRET")

        assert result == "1password-value"
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert call_args[0][0] == ["op", "read", "op://vault/item/field"]

    @patch("subprocess.run")
    def test_falls_back_to_env_when_1password_unavailable(self, mock_run, provider):
        """Test fallback to env var when 1Password CLI fails."""
        os.environ["OP_TEST_SECRET"] = "op://vault/item/field"
        os.environ["TEST_SECRET"] = "env-fallback"
        mock_run.side_effect = FileNotFoundError("op: command not found")

        result = provider.resolve("TEST_SECRET")

        assert result == "env-fallback"

    @patch("subprocess.run")
    def test_falls_back_to_env_when_1password_path_not_set(self, mock_run, provider):
        """Test fallback to env var when OP_* path is not set."""
        os.environ["TEST_SECRET"] = "env-value"
        # Don't set OP_TEST_SECRET

        result = provider.resolve("TEST_SECRET")

        assert result == "env-value"
        mock_run.assert_not_called()

    @patch("subprocess.run")
    def test_caches_1password_results(self, mock_run, provider):
        """Test that 1Password results are cached."""
        os.environ["OP_TEST_SECRET"] = "op://vault/item/field"
        mock_run.return_value = Mock(stdout="1password-value\n", returncode=0)

        result1 = provider.resolve("TEST_SECRET")
        result2 = provider.resolve("TEST_SECRET")

        assert result1 == "1password-value"
        assert result2 == "1password-value"
        # Should only call subprocess once; second resolve used cache
        assert mock_run.call_count == 1

    @patch("subprocess.run")
    def test_trims_whitespace_from_1password_output(self, mock_run, provider):
        """Test that whitespace is trimmed from 1Password output."""
        os.environ["OP_TEST_SECRET"] = "op://vault/item/field"
        mock_run.return_value = Mock(stdout="  1password-value  \n", returncode=0)

        result = provider.resolve("TEST_SECRET")

        assert result == "1password-value"

    @patch("subprocess.run")
    def test_handles_1password_timeout(self, mock_run, provider):
        """Test graceful handling of 1Password timeout."""
        os.environ["OP_TEST_SECRET"] = "op://vault/item/field"
        os.environ["TEST_SECRET"] = "env-fallback"
        mock_run.side_effect = subprocess.TimeoutExpired("op", 5)

        result = provider.resolve("TEST_SECRET")

        assert result == "env-fallback"

    @patch("subprocess.run")
    def test_error_message_includes_key(self, mock_run, provider):
        """Test that error messages include the key name."""
        with pytest.raises(SecretResolutionError) as exc_info:
            provider.resolve("MY_KEY")
        assert "MY_KEY" in str(exc_info.value)


class TestSecretsProviderClear:
    """Tests for the clear() method."""

    def test_clears_cached_entries(self, provider):
        """Test that clear() removes all cached entries."""
        os.environ["TEST_SECRET"] = "value1"
        os.environ["ANOTHER_SECRET"] = "value2"

        provider.resolve("TEST_SECRET")
        provider.resolve("ANOTHER_SECRET")

        provider.clear()

        # After clearing, env-var changes should be visible
        os.environ["TEST_SECRET"] = "new-value1"
        result = provider.resolve("TEST_SECRET")
        assert result == "new-value1"


class TestSecretResolutionError:
    """Tests for the SecretResolutionError exception."""

    def test_captures_key_and_reason(self):
        """Test that the error captures key and reason."""
        error = SecretResolutionError("MY_KEY", "test reason")
        assert error.key == "MY_KEY"
        assert error.reason == "test reason"
        assert "MY_KEY" in str(error)
        assert "test reason" in str(error)


class TestSingleton:
    """Tests for the singleton provider."""

    def test_get_secrets_provider_returns_same_instance(self):
        """Test that get_secrets_provider() returns the same instance."""
        provider1 = get_secrets_provider()
        provider2 = get_secrets_provider()
        assert provider1 is provider2


class TestCacheExpiry:
    """Tests for cache TTL behavior."""

    def test_cache_ttl_respected(self):
        """Test that cached entries respect the TTL."""
        # Create a provider with a very short TTL for testing
        provider = _CachedSecretsProvider(ttl_s=0.01)  # 10ms TTL
        os.environ["TEST_SECRET"] = "value1"

        result1 = provider.resolve("TEST_SECRET")
        assert result1 == "value1"

        # Modify env var
        os.environ["TEST_SECRET"] = "value2"

        # Wait for cache to expire
        import time

        time.sleep(0.02)

        # After TTL expires, should get new value
        result2 = provider.resolve("TEST_SECRET")
        assert result2 == "value2"

        provider.clear()
        os.environ.pop("TEST_SECRET", None)
