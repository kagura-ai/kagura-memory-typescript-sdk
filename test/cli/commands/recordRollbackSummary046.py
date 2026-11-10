"""Record what the Python SDK's rollback models print for the `sleep rollback` cases.

`kagura sleep rollback` prints the JSON dump of the SDK's `RollbackResult`
(a complete rollback) or of `{report_id, error, rollback_summary}` with the
`RollbackSummary` dump (a partial one). This script computes that text from
the installed `kagura-memory` models for every case of
`sleepRollback110.json` whose recorded stdout carries a summary, and for two
replies that carry `related_indexes_reverted` (memory-cloud v0.153.0+).

Two modes, both run from the repository root:

  # 1. Prove the procedure: under 0.44.0 it must reproduce the stdout that
  #    was recorded from the real 0.44.0 CLI, byte for byte.
  uv run --no-project --isolated --with "kagura-memory==0.44.0" \
      python test/cli/commands/recordRollbackSummary046.py --check

  # 2. Record: under 0.46.0, write sleepRollback046.json.
  uv run --no-project --isolated --with "kagura-memory==0.46.0" \
      python test/cli/commands/recordRollbackSummary046.py
"""

from __future__ import annotations

import json
import sys
from importlib.metadata import version
from pathlib import Path

from kagura_memory.models import RollbackResult, RollbackSummary

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "sleepRollback110.json"
TARGET = HERE / "sleepRollback046.json"

# Replies the 0.44.0 record has no case for: the counter of the opt-in Sleep
# related index, on a complete and on a partial rollback.
RELATED_INDEX_CASES = [
    {
        "name": "related index: complete rollback with a count",
        "argv": ["sleep", "rollback", "ctx-1", "r-1", "--yes"],
        "reply": {
            "report_id": "r-1",
            "status": "rolled_back",
            "rollback_summary": {"edges_deleted": 1, "related_indexes_reverted": 2},
        },
    },
    {
        "name": "related index: partial rollback with a count",
        "argv": ["sleep", "rollback", "ctx-1", "r-1", "--yes"],
        "reply": {
            "status": "error",
            "error": "partial_rollback",
            "report_id": "r-1",
            "message": "Some actions failed",
            "rollback_summary": {"related_indexes_reverted": 3, "errors": ["cannot undo merge"]},
        },
    },
]


def printed(reply: dict) -> str:
    """The stdout of `kagura sleep rollback` for one `rollback_sleep_run` reply."""
    if reply.get("error") == "partial_rollback":
        body = {
            "report_id": reply.get("report_id"),
            "error": "partial_rollback",
            "rollback_summary": RollbackSummary.model_validate(reply["rollback_summary"]).model_dump(mode="json"),
        }
    else:
        body = RollbackResult.model_validate(reply).model_dump(mode="json")
    return json.dumps(body, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    installed = version("kagura-memory")
    cases = [
        case
        for case in json.loads(SOURCE.read_text(encoding="utf-8"))
        if '"rollback_summary": {' in case["stdout"]
    ]
    if not cases:
        print("no recorded case carries a summary", file=sys.stderr)
        return 1

    if "--check" in sys.argv[1:]:
        failed = [
            case["name"]
            for case in cases
            if printed(json.loads(case["toolTexts"]["rollback_sleep_run"])) != case["stdout"]
        ]
        print(f"kagura-memory {installed}: {len(cases) - len(failed)} of {len(cases)} recorded stdouts reproduced")
        for name in failed:
            print(f"  differs: {name}", file=sys.stderr)
        return 1 if failed else 0

    record = {
        "recorded_with": f"kagura-memory {installed}",
        "cases": [
            {
                "name": case["name"],
                "stdout": printed(json.loads(case["toolTexts"]["rollback_sleep_run"])),
            }
            for case in cases
        ]
        + [
            {
                "name": extra["name"],
                "argv": extra["argv"],
                "toolText": json.dumps(extra["reply"], ensure_ascii=False),
                "stdout": printed(extra["reply"]),
            }
            for extra in RELATED_INDEX_CASES
        ],
    }
    TARGET.write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"kagura-memory {installed}: wrote {TARGET.name} ({len(record['cases'])} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
