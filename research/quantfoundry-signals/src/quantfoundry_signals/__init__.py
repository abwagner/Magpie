"""quantfoundry-signals — Python SDK for Magpie signal workers.

A worker subclasses :class:`SignalWorker`, sets its model identity +
horizon as class attributes, and implements :meth:`predict`. The SDK
takes care of serialising to the wire schema (mirroring
``src/types/signal.ts``), stamping provenance, and POSTing to the
ingress sidecar at ``/signals`` with bearer auth + exponential
backoff.

Reference: ``docs/tdd/signal-ingress.md``, QF-108.
"""

from quantfoundry_signals.exceptions import (
    SignalAuthError,
    SignalRateLimitError,
    SignalSDKError,
    SignalServerError,
    SignalTransportError,
    SignalValidationError,
)
from quantfoundry_signals.provenance import (
    WORKER_ID_ENV_VAR,
    build_provenance,
    new_run_id,
    resolve_worker_id,
)
from quantfoundry_signals.publisher import (
    DEFAULT_INGRESS_URL,
    TOKEN_ENV_VAR,
    SignalPublisher,
)
from quantfoundry_signals.symbol import (
    EqSymbol,
    FopSymbol,
    FutSymbol,
    OptSymbol,
    ParsedSymbol,
    VSymbol,
    format_symbol,
    parse_symbol,
)
from quantfoundry_signals.types import (
    SCHEMA_VERSION,
    AckMode,
    ClassPayload,
    Horizon,
    HorizonAnchor,
    PointPayload,
    PointUnit,
    Provenance,
    Signal,
    SignalAcceptResponse,
    SignalBatchRequest,
    SignalErrorResponse,
    SignalPayload,
    VolBuyContract,
    VolBuyDirectivePayload,
    VolBuyExit,
    VolBuyExitPayload,
    VolBuyStructure,
)
from quantfoundry_signals.worker import PredictContext, SignalWorker

__all__ = [
    "DEFAULT_INGRESS_URL",
    "SCHEMA_VERSION",
    "TOKEN_ENV_VAR",
    "WORKER_ID_ENV_VAR",
    "AckMode",
    "ClassPayload",
    "EqSymbol",
    "FopSymbol",
    "FutSymbol",
    "Horizon",
    "HorizonAnchor",
    "OptSymbol",
    "ParsedSymbol",
    "PointPayload",
    "PointUnit",
    "PredictContext",
    "Provenance",
    "Signal",
    "SignalAcceptResponse",
    "SignalAuthError",
    "SignalBatchRequest",
    "SignalErrorResponse",
    "SignalPayload",
    "SignalPublisher",
    "SignalRateLimitError",
    "SignalSDKError",
    "SignalServerError",
    "SignalTransportError",
    "SignalValidationError",
    "SignalWorker",
    "VSymbol",
    "VolBuyContract",
    "VolBuyDirectivePayload",
    "VolBuyExit",
    "VolBuyExitPayload",
    "VolBuyStructure",
    "build_provenance",
    "format_symbol",
    "new_run_id",
    "parse_symbol",
    "resolve_worker_id",
]
