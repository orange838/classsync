"""用真实 Worker 验证插件 client.py 的完整流程。

模拟一台设备：配对待测试设备 → 同步（上报状态）→ 拿课表 → 上传本机课表。
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _classsync.client import ApiError, ClassSyncClient, normalize_server_url  # noqa: E402

BASE = "https://classsync.cslblog.dpdns.org"
KEY = Path("../worker/.admin_key.tmp").read_text(encoding="utf-8").strip()


UA = "ClassSync/0.1.0"


def _open(req: urllib.request.Request, timeout: float = 20.0):
    """本地 DNS 偶发抖动，包一层重试。"""
    last = None
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0 * (attempt + 1))
    raise last  # type: ignore[misc]


def admin_login() -> str:
    req = urllib.request.Request(
        BASE + "/api/admin/login",
        data=json.dumps({"key": KEY}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with _open(req) as resp:
        cookies = resp.headers.get_all("Set-Cookie") or []
    cookie = str(cookies[0]).split(";")[0] if cookies else ""
    if not cookie:
        raise RuntimeError("登录失败，没拿到 cookie")
    return cookie


def admin_post(path: str, cookie: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload or {}).encode(),
        headers={"Content-Type": "application/json", "Cookie": cookie, "User-Agent": UA},
        method="POST",
    )
    with _open(req) as resp:
        return json.loads(resp.read().decode())


def admin_get(path: str, cookie: str) -> dict:
    req = urllib.request.Request(BASE + path, headers={"Cookie": cookie, "User-Agent": UA})
    with _open(req) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    cookie = admin_login()
    print("1. 后台登录 OK")

    code = admin_post("/api/admin/pairing", cookie, {"minutes": 30, "device_name": "插件联调机"})["code"]
    print("2. 生成配对码 OK:", code)

    client = ClassSyncClient(normalize_server_url(BASE))
    paired = client.pair(code, "插件联调机")
    token = paired["device_token"]
    device_id = paired["device_id"]
    print("3. 设备配对 OK:", device_id, "轮询间隔", paired["poll_interval"])

    client = ClassSyncClient(normalize_server_url(BASE), token)
    result = client.sync({
        "runtime": {
            "status": "class",
            "title": "语文",
            "period_end": "2026-10-30T13:00:00+00:00",
            "next_title": "数学",
        },
        "env": {
            "app_version": "2.0.0",
            "plugin_version": "0.1.0",
            "data_mode": "user",
            "data_dir": r"C:\Users\x\AppData\Local\Class_Widgets_2",
        },
        "schedule_rev": 0,
        "schedule_hash": None,
        "last_error": "",
    })
    print("4. 同步 OK，课表:", "有" if result.get("schedule") else "无",
          "指令:", len(result.get("commands", [])))

    state = admin_get("/api/admin/state", cookie)
    dev = [d for d in state["devices"] if d["id"] == device_id]
    print("5. 后台看到设备:", json.dumps(dev[0], ensure_ascii=False)[:260] if dev else "没看到")

    # 后台下发 upload_schedule
    cmd = admin_post("/api/admin/command", cookie,
                     {"device_id": device_id, "type": "upload_schedule", "payload": {}})
    print("6. 下发 upload_schedule OK:", cmd)

    result = client.sync({"runtime": {"status": "break"}, "env": {}, "schedule_rev": 0})
    commands = result.get("commands", [])
    print("7. 设备拿到指令:", json.dumps(commands, ensure_ascii=False)[:200])

    if commands:
        cmd_id = commands[0]["id"]
        sample = {
            "meta": {"id": "school", "version": 1, "maxWeekCycle": 2, "startDate": "2026-09-01"},
            "subjects": [{"id": "s1", "name": "语文"}],
            "days": [],
            "overrides": [],
        }
        result = client.sync({
            "runtime": {}, "env": {}, "schedule_rev": 0,
            "acks": [{"id": cmd_id, "ok": True, "result": "已上传本机课表"}],
            "schedule_upload": {"request_id": cmd_id, "payload": sample},
        })
        print("8. 上传本机课表 OK")

    # 后台发布课表
    new_payload = {
        "meta": {"id": "_sync", "version": 1, "maxWeekCycle": 2, "startDate": "2026-09-01"},
        "subjects": [{"id": "s1", "name": "数学"}],
        "days": [],
        "overrides": [],
    }
    print("9. 存草稿:", admin_post(f"/api/admin/draft/{device_id}", cookie, {"payload": new_payload}))
    print("10. 发布:", admin_post(f"/api/admin/publish/{device_id}", cookie))

    result = client.sync({"runtime": {}, "env": {}, "schedule_rev": 0})
    sched = result.get("schedule")
    print("11. 设备拿到课表 v%s" % (sched["revision"] if sched else None),
          "科目:", sched["payload"]["subjects"] if sched else None)

    result = client.sync({"runtime": {}, "env": {}, "schedule_rev": sched["revision"]})
    print("12. 已应用后再同步，课表:", result.get("schedule"))

    # 解绑清理
    client.unpair()
    state = admin_get("/api/admin/state", cookie)
    still = [d for d in state["devices"] if d["id"] == device_id]
    print("13. 解绑 OK，设备残留:", len(still))

    # 错误路径
    try:
        bad = ClassSyncClient(normalize_server_url(BASE), "cst_invalidtoken")
        bad.sync({"runtime": {}, "env": {}, "schedule_rev": 0})
        print("14. 无效令牌未被拒绝 ← 有问题")
    except ApiError as exc:
        print("14. 无效令牌被正确拒绝:", exc)

    try:
        ClassSyncClient(normalize_server_url(BASE)).pair("WRONGCODE", "x")
        print("15. 错误配对码未被拒绝 ← 有问题")
    except ApiError as exc:
        print("15. 错误配对码被正确拒绝:", exc)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
