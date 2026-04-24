import json
import sys
from datetime import datetime, timezone
from config import CONFIG

LEVELS = {"debug": 0, "info": 1, "warn": 2, "error": 3}
_current_level = LEVELS.get(CONFIG.log_level.lower(), 1)


def _log(level: str, msg: str, meta: dict | None = None) -> None:
    if LEVELS.get(level, 0) < _current_level:
        return
    line = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "msg": msg,
        **(meta or {}),
    }
    print(json.dumps(line), file=sys.stdout, flush=True)


class Logger:
    def debug(self, msg: str, meta: dict | None = None) -> None:
        _log("debug", msg, meta)

    def info(self, msg: str, meta: dict | None = None) -> None:
        _log("info", msg, meta)

    def warn(self, msg: str, meta: dict | None = None) -> None:
        _log("warn", msg, meta)

    def error(self, msg: str, meta: dict | None = None) -> None:
        _log("error", msg, meta)


logger = Logger()
