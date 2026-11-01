"""ClassSync 设备端 HTTP 客户端。

只用标准库 urllib，避免插件额外打包 requests。
"""

from __future__ import annotations

import json
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

PLUGIN_VERSION = "0.1.0"

# 网络抖动（DNS 解析失败、连接被重置）很常见，重试 2 次
MAX_ATTEMPTS = 3
RETRY_BACKOFF = 0.8

_ORIG_GETADDRINFO = socket.getaddrinfo


def _prefer_ipv4() -> None:
    """让解析结果优先返回 IPv4，避免部分网络 IPv6 不通导致的长时间等待。"""
    if getattr(socket.getaddrinfo, "_classsync_patched", False):
        return

    def _patched(host, port, family=0, type=0, proto=0, flags=0):
        results = _ORIG_GETADDRINFO(host, port, family, type, proto, flags)
        if not results:
            return results
        v4 = [item for item in results if item[0] == socket.AF_INET]
        return v4 + [item for item in results if item[0] != socket.AF_INET] if v4 else results

    _patched._classsync_patched = True  # type: ignore[attr-defined]
    socket.getaddrinfo = _patched  # type: ignore[assignment]

# 优先用 certifi 的证书链（CW2 自带 certifi），否则退回系统默认
def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        try:
            return ssl.create_default_context()
        except Exception:
            return ssl._create_unverified_context()  # noqa: SLF001


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class ClassSyncClient:
    def __init__(self, server_url: str, token: str = "", timeout: float = 12.0) -> None:
        self.server_url = (server_url or "").strip().rstrip("/")
        self.token = token or ""
        self.timeout = timeout
        self._ctx = _ssl_context()

    # ------------------------------------------------------------------ 公共
    def pair(self, pairing_code: str, device_name: str) -> dict[str, Any]:
        return self._post(
            "/api/device/pair",
            {"pairing_code": pairing_code, "device_name": device_name},
            auth=False,
        )

    def sync(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/api/device/sync", payload)

    def unpair(self) -> dict[str, Any]:
        return self._post("/api/device/unpair", {})

    def fetch_package(self, package_id: str) -> bytes:
        """下载后台暂存的插件包（只下载，不安装）。"""
        if not self.server_url:
            raise ApiError("服务器地址为空")
        if not self.token:
            raise ApiError("设备令牌缺失，请解除绑定后重新配对")
        url = f"{self.server_url}/api/device/package/{urllib.parse.quote(str(package_id))}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": f"ClassSync/{PLUGIN_VERSION}",
                "Authorization": f"Bearer {self.token}",
            },
            method="GET",
        )
        try:
            _prefer_ipv4()
            with urllib.request.urlopen(
                request, timeout=max(self.timeout, 60.0), context=self._ctx
            ) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            detail = _parse_error(exc)
            raise ApiError(detail[0], exc.code, detail[1]) from None
        except urllib.error.URLError as exc:
            raise ApiError(f"无法连接服务器：{exc.reason}") from None
        except TimeoutError:
            raise ApiError("下载插件包超时") from None
        except Exception as exc:  # noqa: BLE001
            raise ApiError(f"下载插件包失败：{exc}") from None

    # ------------------------------------------------------------------ 内部
    def _post(self, path: str, payload: dict[str, Any], auth: bool = True) -> dict[str, Any]:
        last: Optional[ApiError] = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                return self._post_once(path, payload, auth)
            except ApiError as exc:
                # 只有网络类错误（没拿到 HTTP 响应）才值得重试
                if exc.status != 0 or exc.code:
                    raise
                last = exc
                if attempt + 1 < MAX_ATTEMPTS:
                    time.sleep(RETRY_BACKOFF * (attempt + 1))
        raise last or ApiError("请求失败")

    def _post_once(self, path: str, payload: dict[str, Any], auth: bool = True) -> dict[str, Any]:
        if not self.server_url:
            raise ApiError("服务器地址为空")
        url = self.server_url + path
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": f"ClassSync/{PLUGIN_VERSION}",
        }
        if auth:
            if not self.token:
                raise ApiError("设备令牌缺失，请解除绑定后重新配对")
            headers["Authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            _prefer_ipv4()
            with urllib.request.urlopen(request, timeout=self.timeout, context=self._ctx) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = _parse_error(exc)
            raise ApiError(detail[0], exc.code, detail[1]) from None
        except urllib.error.URLError as exc:
            raise ApiError(f"无法连接服务器：{exc.reason}") from None
        except TimeoutError:
            raise ApiError("连接服务器超时") from None
        except Exception as exc:  # noqa: BLE001
            raise ApiError(f"请求失败：{exc}") from None

        try:
            data = json.loads(raw)
        except ValueError:
            raise ApiError("服务器返回的不是合法 JSON") from None
        if not isinstance(data, dict):
            raise ApiError("服务器返回格式异常")
        if data.get("ok") is False:
            raise ApiError(str(data.get("error") or "服务器返回失败"), 0, str(data.get("code") or ""))
        return data


def _parse_error(exc: "urllib.error.HTTPError") -> tuple[str, str]:
    try:
        raw = exc.read().decode("utf-8", "replace")
        data = json.loads(raw)
        if isinstance(data, dict):
            return str(data.get("error") or f"HTTP {exc.code}"), str(data.get("code") or "")
    except Exception:  # noqa: BLE001
        pass
    return f"HTTP {exc.code} {exc.reason}", ""


def normalize_server_url(text: str) -> str:
    """把用户随手输入的地址补全成 https://host 形式。"""
    value = (text or "").strip()
    if not value:
        return ""
    if not value.lower().startswith(("http://", "https://")):
        value = "https://" + value
    return value.rstrip("/")


def try_fetch_text(url: str, timeout: float = 10.0) -> Optional[str]:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": f"ClassSync/{PLUGIN_VERSION}"})
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as resp:
            return resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None
