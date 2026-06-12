"""Schwab broker adapters for NautilusTrader.

Phase 4 cluster (QF-161 OAuth → QF-166 OPTIONS_BOOK). Each module is
imported by the NT `LiveExecutionClient` / `LiveMarketDataClient`
factories the strategy-runtime container ships, not by strategy code
directly — strategies receive an NT-typed client, not a Schwab one.
"""

from magpie_schwab_nt.account_activity import (
    ACCT_ACTIVITY_MESSAGE_TYPES,
    CancelReplaceEvent,
    FillEvent,
    OrderEvent,
    OrderEventKind,
    RawActivityEvent,
    parse_account_activity_row,
)
from magpie_schwab_nt.auth import (
    AuthExpiredError,
    SchwabAuthClient,
    SchwabTokenStore,
)
from magpie_schwab_nt.book import (
    OPTIONS_BOOK_FIELDS,
    OPTIONS_BOOK_FIELDS_PARAM,
    BookIngestResult,
    BookSide,
    DeltaAction,
    OptionBookAggregator,
    OptionBookDelta,
    OptionBookLevel,
    OptionBookSnapshot,
    diff_books,
    parse_options_book_row,
)
from magpie_schwab_nt.exec_client import (
    SchwabExecError,
    SchwabOrder,
    SchwabPosition,
    SchwabRestExecClient,
)
from magpie_schwab_nt.order_status import (
    ORDER_STATUS_MAPPING,
    NTOrderStatus,
    derive_order_status,
    is_terminal,
)
from magpie_schwab_nt.quotes import (
    LEVELONE_FUTURES_OPTIONS_FIELDS,
    LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM,
    LEVELONE_OPTIONS_FIELDS,
    LEVELONE_OPTIONS_FIELDS_PARAM,
    OptionQuote,
    QuoteAggregator,
    parse_levelone_futures_options_row,
    parse_levelone_options_row,
)
from magpie_schwab_nt.streaming import (
    BackpressurePolicy,
    SchwabStreamerClient,
    SchwabStreamerInfo,
    StreamerError,
    StreamerLoginError,
    Subscription,
    iter_queue,
)
from magpie_schwab_nt.trades import (
    TIMESALE_FUTURES_OPTIONS_FIELDS,
    TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM,
    TIMESALE_OPTIONS_FIELDS,
    TIMESALE_OPTIONS_FIELDS_PARAM,
    AggressorSide,
    OptionTrade,
    classify_aggressor,
    parse_timesale_futures_options_row,
    parse_timesale_options_row,
)

__all__ = [
    "ACCT_ACTIVITY_MESSAGE_TYPES",
    "LEVELONE_FUTURES_OPTIONS_FIELDS",
    "LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM",
    "LEVELONE_OPTIONS_FIELDS",
    "LEVELONE_OPTIONS_FIELDS_PARAM",
    "OPTIONS_BOOK_FIELDS",
    "OPTIONS_BOOK_FIELDS_PARAM",
    "ORDER_STATUS_MAPPING",
    "TIMESALE_FUTURES_OPTIONS_FIELDS",
    "TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM",
    "TIMESALE_OPTIONS_FIELDS",
    "TIMESALE_OPTIONS_FIELDS_PARAM",
    "AggressorSide",
    "AuthExpiredError",
    "BackpressurePolicy",
    "BookIngestResult",
    "BookSide",
    "CancelReplaceEvent",
    "DeltaAction",
    "FillEvent",
    "NTOrderStatus",
    "OptionBookAggregator",
    "OptionBookDelta",
    "OptionBookLevel",
    "OptionBookSnapshot",
    "OptionQuote",
    "OptionTrade",
    "OrderEvent",
    "OrderEventKind",
    "QuoteAggregator",
    "RawActivityEvent",
    "SchwabAuthClient",
    "SchwabExecError",
    "SchwabOrder",
    "SchwabPosition",
    "SchwabRestExecClient",
    "SchwabStreamerClient",
    "SchwabStreamerInfo",
    "SchwabTokenStore",
    "StreamerError",
    "StreamerLoginError",
    "Subscription",
    "classify_aggressor",
    "derive_order_status",
    "diff_books",
    "is_terminal",
    "iter_queue",
    "parse_account_activity_row",
    "parse_levelone_futures_options_row",
    "parse_levelone_options_row",
    "parse_options_book_row",
    "parse_timesale_futures_options_row",
    "parse_timesale_options_row",
]
