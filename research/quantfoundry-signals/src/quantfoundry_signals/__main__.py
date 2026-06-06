"""Module entry point so ``python -m quantfoundry_signals`` works.

Delegates to :func:`quantfoundry_signals.cli.main`. The CLI is
documented in QF-108's PR body and is the canonical entry point for
running a :class:`SignalWorker` subclass as a one-shot job.
"""

from __future__ import annotations

import sys

from quantfoundry_signals.cli import main

if __name__ == "__main__":
    sys.exit(main())
