"""ClassSync 课表同步插件。

行为约定：
- 从自建服务器拉取课表，落地为独立课表 `_sync`，**不碰** 原课表文件。
- 后台必须手动「发布」后才产生新版本，设备下次同步才拿到。
- 正在上课时收到新课表 → 先挂起，等下一个课间再切换。
- 支持便携版检测与切换（冰点还原机器需要把数据放到 D 盘）。
"""

from __future__ import annotations

import hashlib
import json
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from loguru import logger
from PySide6.QtCore import QTimer, Signal, Slot

from ClassWidgets.SDK import CW2Plugin, PluginAPI

from _classsync import portable
from _classsync.client import PLUGIN_VERSION, normalize_server_url
from _classsync.config import ClassSyncConfig
from _classsync.worker import NetworkWorker

IN_CLASS_STATUS = "class"
NOTIFY_PROVIDER_ID = "org.cslblog.classsync.notify"


class Plugin(CW2Plugin):
    configChanged = Signal()
    syncStatusChanged = Signal(str, str)
    pairResult = Signal(bool, str)

    def __init__(self, api: PluginAPI) -> None:
        super().__init__(api)
        self._config = ClassSyncConfig()
        self._worker = NetworkWorker(self)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.doSync)
        self._syncing = False
        self._applying = False
        self._pending_server_url = ""
        self._need_upload: Optional[dict] = None   # 待上传的本机课表
        self._sent_acks: list[dict] = []
        self._provider = None

        self._worker.pairFinished.connect(self._on_pair_finished)
        self._worker.syncFinished.connect(self._on_sync_finished)
        self._worker.unpairFinished.connect(self._on_unpair_finished)

    # ================================================================ 生命周期
    def on_load(self) -> None:
        super().on_load()
        self.api.config.register_plugin_model(self.pid, self._config)
        model = self.api.config.get_plugin_model(self.pid)
        if model is not None:
            self._config = model

        self.api.ui.register_settings_page(
            qml_path="qml/SyncSettings.qml",
            title="课表同步",
            icon="ic_fluent_cloud_arrow_down_20_regular",
        )

        try:
            self._provider = self.api.notification.register_provider(
                NOTIFY_PROVIDER_ID, name="课表同步", use_system_notify=True
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[ClassSync] 注册通知失败: {exc}")

        try:
            self.api.runtime.statusChanged.connect(self._on_status_changed)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[ClassSync] 无法监听状态变化: {exc}")

        if self._config.pending_payload:
            logger.info("[ClassSync] 有挂起的课表，等下个课间切换")
        if self._config.paired and self._config.device_token:
            self._schedule_next_sync(5)
        elif self._config.paired:
            self._set_error("设备凭据缺失，请解除绑定后重新配对")

        logger.info(f"[ClassSync] loaded ({portable.current_location().mode_text})")

    def on_unload(self) -> None:
        self._timer.stop()
        self._worker.shutdown()
        try:
            self.api.runtime.statusChanged.disconnect(self._on_status_changed)
        except Exception:  # noqa: BLE001
            pass
        logger.info("[ClassSync] unloaded")

    # ================================================================ 给 QML 的槽
    @Slot(result=str)
    def getServerUrl(self) -> str:
        return self._config.server_url

    @Slot(result=bool)
    def isPaired(self) -> bool:
        return self._config.paired

    @Slot(result=str)
    def getDeviceName(self) -> str:
        return self._config.device_name

    @Slot(result=str)
    def getLastSyncTime(self) -> str:
        return self._config.last_sync_time

    @Slot(result=str)
    def getLastError(self) -> str:
        return self._config.last_error

    @Slot(result=str)
    def getLastMessage(self) -> str:
        return self._config.last_message

    @Slot(result=str)
    def getModeInfo(self) -> str:
        return portable.describe()

    @Slot(result=bool)
    def isPortable(self) -> bool:
        return portable.current_location().portable

    @Slot(result=int)
    def getScheduleRevision(self) -> int:
        return self._config.applied_revision

    @Slot(result=str)
    def getPendingInfo(self) -> str:
        if not self._config.pending_payload:
            return ""
        return f"v{self._config.pending_revision} 课表已收到，等课间切换"

    @Slot(result=str)
    def getPollInterval(self) -> str:
        return str(self._config.poll_interval_seconds)

    # ------------------------------------------------------------------ 配对
    @Slot(str, str, str)
    def doPair(self, server_url: str, pairing_code: str, device_name: str) -> None:
        if self._syncing or self._config.paired:
            return
        url = normalize_server_url(server_url)
        code = (pairing_code or "").strip().upper()
        name = (device_name or "").strip() or socket.gethostname()
        if not url:
            self.pairResult.emit(False, "服务器地址不能为空")
            return
        if len(code) < 4:
            self.pairResult.emit(False, "配对码不正确")
            return
        self._syncing = True
        self._pending_server_url = url
        self.syncStatusChanged.emit("syncing", "正在配对…")
        self._worker.pair(url, code, name)

    @Slot()
    def doUnpair(self) -> None:
        if not self._config.paired or self._syncing:
            return
        if not self._config.device_token:
            self._reset_to_defaults()
            return
        self._syncing = True
        self.syncStatusChanged.emit("syncing", "正在解除绑定…")
        self._worker.unpair(self._config.server_url, self._config.device_token)

    # ------------------------------------------------------------------ 同步
    @Slot()
    def doSync(self) -> None:
        if not self._config.paired or self._syncing:
            return
        if not self._config.device_token:
            self._set_error("设备凭据缺失，请解除绑定后重新配对")
            return
        self._syncing = True
        self._sent_acks = [dict(item) for item in self._config.pending_acks]
        self.syncStatusChanged.emit("syncing", "正在同步…")
        self._worker.sync(self._config.server_url, self._config.device_token, self._build_payload())

    def _build_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "runtime": self._runtime_snapshot(),
            "env": self._env_snapshot(),
            "schedule_rev": self._config.applied_revision,
            "schedule_hash": self._config.schedule_hash,
            "last_error": self._config.last_error,
        }
        if self._config.pending_acks:
            payload["acks"] = self._config.pending_acks
        if self._need_upload:
            payload["schedule_upload"] = self._need_upload
        return payload

    def _runtime_snapshot(self) -> dict[str, Any]:
        try:
            remaining = self.api.runtime.remaining_time or {}
            seconds = int(remaining.get("minute", 0)) * 60 + int(remaining.get("second", 0))
            status = str(self.api.runtime.current_status or "")
            title = self.api.runtime.current_title or ""
            if not title and self.api.runtime.current_subject:
                title = str(self.api.runtime.current_subject.get("name", ""))
            next_title = self._next_title()
            # 上报绝对结束时刻，后台用浏览器本地时钟倒计时，观感就是实时的
            period_end = ""
            if status == IN_CLASS_STATUS and seconds > 0:
                period_end = (
                    datetime.now(timezone.utc) + timedelta(seconds=seconds)
                ).isoformat(timespec="seconds")
            return {
                "status": status,
                "title": title,
                "period_end": period_end,
                "next_title": next_title,
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[ClassSync] 读取运行时状态失败: {exc}")
            return {"status": "", "title": "", "period_end": "", "next_title": ""}

    def _next_title(self) -> str:
        try:
            entries = self.api.runtime.next_entries or []
        except Exception:  # noqa: BLE001
            return ""
        subjects = self._subjects_by_id()
        for entry in entries:
            title = entry.get("title") or ""
            if not title:
                subject_id = entry.get("subjectId")
                if subject_id and str(subject_id) in subjects:
                    title = subjects[str(subject_id)]
            if title and str(entry.get("type", "class")) == "class":
                return str(title)
        return ""

    def _subjects_by_id(self) -> dict[str, str]:
        try:
            schedule = self.api.schedule.get()
            subjects = getattr(schedule, "subjects", None) or []
            mapping: dict[str, str] = {}
            for subject in subjects:
                sid = getattr(subject, "id", None)
                name = getattr(subject, "name", None)
                if sid and name:
                    mapping[str(sid)] = str(name)
            return mapping
        except Exception:  # noqa: BLE001
            return {}

    def _env_snapshot(self) -> dict[str, str]:
        loc = portable.current_location()
        return {
            "app_version": str(self._application_info().get("version", "")),
            "plugin_version": PLUGIN_VERSION,
            "data_mode": "portable" if loc.portable else "user",
            "data_dir": str(loc.work_dir),
        }

    # ------------------------------------------------------------------ 便携版
    @Slot(result=str)
    def doSwitchToPortable(self) -> str:
        loc = portable.current_location()
        if loc.portable:
            return f"当前已经是便携版\n数据目录：{loc.work_dir}"
        plan = portable.plan_switch_to_portable()
        if not plan.ok:
            return plan.message
        result = portable.perform_switch_to_portable(plan)
        if result.ok:
            self.api.config.save()
        return result.message

    @Slot(result=str)
    def doSwitchBackToUserDir(self) -> str:
        return portable.switch_back_to_user_dir().message

    @Slot()
    def doRestartApp(self) -> None:
        QTimer.singleShot(0, self.api.application.restart)

    # ================================================================ 回调
    @Slot(bool, dict, str)
    def _on_pair_finished(self, success: bool, data: dict, error: str) -> None:
        self._syncing = False
        if not success:
            self._set_error(error)
            self.pairResult.emit(False, error)
            return
        try:
            self._config.server_url = self._pending_server_url
            self._config.device_id = str(data.get("device_id", ""))
            self._config.device_token = str(data.get("device_token", ""))
            self._config.device_name = str(data.get("device_name", ""))
            self._config.poll_interval_seconds = int(data.get("poll_interval") or 120)
            self._config.paired = True
            self._config.last_error = ""
            self._config.last_message = "配对成功"
            self.api.config.save()
        except Exception as exc:  # noqa: BLE001
            self._set_error(f"无法保存配对信息：{exc}")
            self.pairResult.emit(False, str(exc))
            return
        self.configChanged.emit()
        self.pairResult.emit(True, "配对成功")
        self.syncStatusChanged.emit("success", "配对成功")
        self._schedule_next_sync(1)

    @Slot(bool, str)
    def _on_unpair_finished(self, success: bool, error: str) -> None:
        self._syncing = False
        if not success:
            self._set_error(error)
            return
        self._reset_to_defaults()
        self.syncStatusChanged.emit("success", "已解除绑定")

    def _reset_to_defaults(self) -> None:
        defaults = ClassSyncConfig()
        for name in type(self._config).model_fields:
            setattr(self._config, name, getattr(defaults, name))
        self._need_upload = None
        self._sent_acks = []
        self.api.config.save()
        self.configChanged.emit()

    @Slot(bool, dict, str)
    def _on_sync_finished(self, success: bool, data: dict, error: str) -> None:
        self._syncing = False
        if not success:
            self._set_error(error)
            self._schedule_next_sync(min(max(self._config.poll_interval_seconds * 2, 30), 300))
            return

        self._need_upload = None
        # 清掉这次已经发出去的 ack
        sent_ids = {str(item.get("id")) for item in self._sent_acks if item.get("id")}
        if sent_ids:
            self._config.pending_acks = [
                item for item in self._config.pending_acks if str(item.get("id")) not in sent_ids
            ]
        self._sent_acks = []

        commands: list = []
        try:
            self._config.poll_interval_seconds = int(
                data.get("poll_interval") or self._config.poll_interval_seconds
            )

            schedule = data.get("schedule")
            if isinstance(schedule, dict) and schedule.get("payload"):
                self._handle_incoming_schedule(
                    int(schedule.get("revision") or 0), schedule.get("payload") or {}
                )

            commands = data.get("commands") or []
            if commands:
                self._handle_commands(commands)

            self._config.last_sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self._config.last_error = ""
            if not self._config.pending_payload:
                self._config.last_message = "同步正常"
            self.api.config.save()
            self.configChanged.emit()
            self.syncStatusChanged.emit("success", "同步成功")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[ClassSync] 处理同步响应失败")
            self._set_error(f"应用同步结果失败：{exc}")

        interval = self._config.poll_interval_seconds
        if self._need_upload or self._config.pending_acks:
            interval = 2
        self._schedule_next_sync(interval)

    # ================================================================ 课表落地
    def _handle_incoming_schedule(self, revision: int, payload: dict) -> None:
        if revision <= self._config.applied_revision:
            return
        if self._is_in_class():
            # 上课中：先挂起，等课间再切
            self._config.pending_revision = revision
            self._config.pending_payload = payload
            self._config.last_message = f"已收到 v{revision} 课表，等课间切换"
            logger.info(f"[ClassSync] 上课中，v{revision} 挂起")
            return
        self._apply_schedule(revision, payload)

    def _apply_schedule(self, revision: int, payload: dict) -> bool:
        name = self._config.managed_schedule_name or "_sync"
        digest = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:32]

        previous = self._current_schedule_name()
        self._applying = True
        try:
            names = [
                str(item.get("name", ""))
                for item in (self.api.schedulemanagement.list() or [])
            ]
            exists = name in names
            if not exists and not self.api.schedulemanagement.add(name):
                raise RuntimeError(f"创建课表 {name} 失败")
            if not self.api.schedulemanagement.switch(name):
                raise RuntimeError(f"切换到课表 {name} 失败")

            readonly = self.api.schedule.readonly
            self.api.schedule.set_readonly(False)
            try:
                if not self.api.schedule.update(payload):
                    raise RuntimeError("写入课表数据失败")
                if not self.api.schedulemanagement.save(name):
                    raise RuntimeError("保存课表失败")
            finally:
                self.api.schedule.set_readonly(readonly)
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[ClassSync] 课表落地失败: {exc}")
            if previous and previous != name:
                try:
                    self.api.schedulemanagement.switch(previous)
                except Exception:  # noqa: BLE001
                    pass
            self._set_error(f"课表落地失败：{exc}")
            return False
        finally:
            self._applying = False

        self._config.applied_revision = revision
        self._config.schedule_hash = digest
        self._config.pending_revision = 0
        self._config.pending_payload = {}
        self._config.last_message = f"已应用课表 v{revision}"
        self.api.config.save()
        self.configChanged.emit()
        logger.info(f"[ClassSync] 已应用课表 v{revision} → {name}")

        if self._provider is not None:
            try:
                self._provider.push(
                    level=1,
                    title="课表已更新",
                    message=f"已切换到最新课表（v{revision}）",
                    duration=6000,
                    closable=True,
                )
            except Exception:  # noqa: BLE001
                pass
        return True

    def _current_schedule_name(self) -> Optional[str]:
        try:
            configs = self.api.globalconfig.configs.data
            value = configs.get("schedule", {}).get("current_schedule")
            return str(value) if value else None
        except Exception:  # noqa: BLE001
            return None

    def _is_in_class(self) -> bool:
        try:
            return str(self.api.runtime.current_status or "") == IN_CLASS_STATUS
        except Exception:  # noqa: BLE001
            return False

    @Slot(str)
    def _on_status_changed(self, status: str) -> None:
        if self._applying or not self._config.pending_payload:
            return
        if str(status or "") == IN_CLASS_STATUS:
            return
        # 课间到了，切换挂起的课表
        revision = int(self._config.pending_revision or 0)
        payload = dict(self._config.pending_payload)
        logger.info(f"[ClassSync] 课间到，应用挂起的 v{revision}")
        self._apply_schedule(revision, payload)

    # ================================================================ 指令
    def _handle_commands(self, commands: list) -> None:
        acks: list[dict] = []
        immediate = False
        for command in commands:
            if not isinstance(command, dict):
                continue
            command_id = str(command.get("id", ""))
            command_type = str(command.get("type", ""))
            if not command_id:
                continue
            try:
                if command_type == "sync_now":
                    acks.append({"id": command_id, "ok": True, "result": "立即同步"})
                    immediate = True
                elif command_type == "upload_schedule":
                    data = self._read_current_schedule_dict()
                    if data:
                        self._need_upload = {"request_id": command_id, "payload": data}
                        acks.append({"id": command_id, "ok": True, "result": "已上传本机课表"})
                        immediate = True
                    else:
                        acks.append({"id": command_id, "ok": False, "result": "读取本机课表失败"})
                elif command_type == "switch_portable":
                    message = self.doSwitchToPortable()
                    ok = "已切换到便携版" in message
                    acks.append(
                        {"id": command_id, "ok": ok, "result": message.splitlines()[0][:200]}
                    )
                    if ok:
                        self._queue_restart()
                elif command_type == "restart_app":
                    acks.append({"id": command_id, "ok": True, "result": "即将重启"})
                    self._queue_restart()
                else:
                    acks.append(
                        {"id": command_id, "ok": False, "result": f"不支持的指令 {command_type}"}
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"[ClassSync] 指令执行失败 {command_type}")
                acks.append({"id": command_id, "ok": False, "result": str(exc)[:200]})

        if acks:
            merged = {
                str(item.get("id")): item
                for item in self._config.pending_acks
                if isinstance(item, dict) and item.get("id")
            }
            for ack in acks:
                merged[str(ack["id"])] = ack
            self._config.pending_acks = list(merged.values())[-50:]
        # immediate 时由 _on_sync_finished 末尾的 interval=2 触发下一次同步

    def _read_current_schedule_dict(self) -> Optional[dict]:
        try:
            current = self._current_schedule_name()
            items = self.api.schedulemanagement.list() or []
            target = None
            for item in items:
                if current and str(item.get("name")) == str(current):
                    target = item
                    break
            if target is None and items:
                target = items[0]
            if target is None:
                return None
            path = Path(str(target.get("path", "")))
            if not path.is_file():
                return None
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else None
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[ClassSync] 读取本机课表失败: {exc}")
            return None

    def _queue_restart(self) -> None:
        QTimer.singleShot(1500, self.api.application.restart)

    # ================================================================ 工具
    def _application_info(self) -> dict:
        try:
            return self.api.application.get_info()
        except Exception:  # noqa: BLE001
            return {}

    def _schedule_next_sync(self, seconds: int) -> None:
        if self._config.paired:
            self._timer.start(max(2, int(seconds)) * 1000)

    def _set_error(self, message: str) -> None:
        text = str(message)[:500]
        self._config.last_error = text
        self._config.last_message = text[:200]
        try:
            self.api.config.save()
        except Exception:  # noqa: BLE001
            pass
        self.configChanged.emit()
        self.syncStatusChanged.emit("error", text)