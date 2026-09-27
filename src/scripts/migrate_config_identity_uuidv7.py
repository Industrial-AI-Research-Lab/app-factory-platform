"""Consolidated one-shot config identity + UUIDv7 migration.

Supersedes migrate_config_identity, migrate_llm_function_names,
migrate_path_a_wire_names and migrate_storage_ids_to_uuidv7.

Usage:
    python -m scripts.migrate_config_identity_uuidv7
    python -m scripts.migrate_config_identity_uuidv7 --apply
    python -m scripts.migrate_config_identity_uuidv7 --apply --database synaps
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from config.migrate_config_identity_uuidv7 import main

if __name__ == "__main__":
    main()
