"""后台网络线程：所有 HTTP 请求都丢到子线程，避免卡住 UI。"""

from __future__ import annotations

import threading
from typing import Any, Callable

from PySide6.QtCore import QObject, Signal

from .client import ApiError, ClassSyncClient


class NetworkWorker(QObject):
    pairFinished = Signal(bool, dict, str)
    syncFinished = Signal(bool, dict, str)
    unpairFinished = Signal(bool, str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._active = True

    def shutdown(self) -> None:
        self._active = False

    # ------------------------------------------------------------------ 请求
    def pair(self, server_url: str, pairing_code: str, device_name: str) -> None:
        client = ClassSyncClient(server_url)
        self._run(
            lambda: client.pair(pairing_code, device_name),
            lambda data: self.pairFinished.emit(True, data, ""),
            lambda err: self.pairFinished.emit(False, {}, err),
        )

    def sync(self, server_url: str, token: str, payload: dict[str, Any]) -> None:
        client = ClassSyncClient(server_url, token)
        self._run(
            lambda: client.sync(payload),
            lambda data: self.syncFinished.emit(True, data, ""),
            lambda err: self.syncFinished.emit(False, {}, err),
        )

    def unpair(self, server_url: str, token: str) -> None:
        client = ClassSyncClient(server_url, token)
        self._run(
            lambda: client.unpair(),
            lambda _data: self.unpairFinished.emit(True, ""),
            lambda err: self.unpairFinished.emit(False, err),
        )

    # ------------------------------------------------------------------ 内部
    def _run(
        self,
        request: Callable[[], dict[str, Any]],
        on_success: Callable[[dict[str, Any]], None],
        on_error: Callable[[str], None],
    ) -> None:
        def target() -> None:
            try:
                result = request()
                if self._active:
                    on_success(result)
            except ApiError as exc:
                if self._active:
                    on_error(str(exc))
            except Exception as exc:  # noqa: BLE001
                if self._active:
                    on_error(f"{type(exc).__name__}: {exc}")

        threading.Thread(target=target, daemon=True, name="classsync-net").start()
