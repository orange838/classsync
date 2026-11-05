"""ClassSync 课表同步插件。

行为约定：
- 从自建服务器拉取课表，落地为独立课表 `_sync`，**不碰** 原课表文件。
- 后台必须手动「发布」后才产生新版本，设备下次同步才拿到。
- 正在上课时收到新课表 → 先挂起，等下一个课间再切换。
- 支持便携版检测与切换（冰点还原机器需要把数据放到 D 盘）。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import socket
import time
import zipfile
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
PLUGIN_ID = "org.cslblog.classsync"


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
            "plugins": self._plugins_snapshot(),
            "pending_install": self._pending_install_text(),
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
            self._config.poll_interval_seconds = int(data.get("poll_interval") or 30)
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
        # 第一次接管前记下用户自己在用的课表，之后“拉取本机课表”优先读它，
        # 避免把下发的 _sync 当成用户原课表传回后台
        if previous and previous != name and not self._config.baseline_schedule_name:
            self._config.baseline_schedule_name = previous
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
                    found = self._read_current_schedule_dict()
                    if found:
                        self._need_upload = {"request_id": command_id, "payload": found["data"]}
                        acks.append(
                            {
                                "id": command_id,
                                "ok": True,
                                "result": f"已上传课表「{found['name']}」",
                            }
                        )
                        immediate = True
                    else:
                        acks.append({"id": command_id, "ok": False, "result": "读取本机课表失败"})
                elif command_type == "switch_portable":
                    # 按当前实际位置反向切换，和后台按钮文案一致
                    if portable.current_location().portable:
                        message = self.doSwitchBackToUserDir()
                        ok = "已切回用户目录" in message
                    else:
                        message = self.doSwitchToPortable()
                        ok = "已切换到便携版" in message
                    acks.append(
                        {"id": command_id, "ok": ok, "result": message.splitlines()[0][:200]}
                    )
                    if ok:
                        self._queue_restart()
                elif command_type == "plugin_set_enabled":
                    cmd_payload = command.get("payload") or {}
                    ok, message = self._set_plugin_enabled(
                        str(cmd_payload.get("id") or ""), bool(cmd_payload.get("enabled"))
                    )
                    acks.append({"id": command_id, "ok": ok, "result": message[:200]})
                    if ok:
                        immediate = True
                elif command_type == "plugin_stage":
                    cmd_payload = command.get("payload") or {}
                    ok, message = self._stage_package(
                        str(cmd_payload.get("package_id") or ""),
                        str(cmd_payload.get("sha256") or ""),
                        str(cmd_payload.get("url") or ""),
                    )
                    acks.append({"id": command_id, "ok": ok, "result": message[:200]})
                    if ok:
                        immediate = True
                elif command_type == "plugin_uninstall":
                    cmd_payload = command.get("payload") or {}
                    ok, message = self._uninstall_plugin(str(cmd_payload.get("id") or ""))
                    acks.append({"id": command_id, "ok": ok, "result": message[:200]})
                    if ok:
                        immediate = True
                elif command_type == "show_banner":
                    cmd_payload = command.get("payload") or {}
                    text = str(cmd_payload.get("text") or "").strip()
                    if not text:
                        raise ValueError("横幅文字为空")
                    try:
                        duration = int(cmd_payload.get("duration") or 0)
                    except (TypeError, ValueError):
                        duration = 0
                    ok, message = self._show_banner(text, max(0, duration))
                    acks.append({"id": command_id, "ok": ok, "result": message[:200]})
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

    def _show_banner(self, text: str, duration: int) -> tuple[bool, str]:
        """远程横幅：只走「更好的自动化」的顶部横幅模式，不做全屏、也不降级成通知。

        两个插件是独立仓库，这里用插件管理器按 id 取对方实例，拿到 playBanner 就调用；
        对方没装或版本太旧时直接回失败，让后台能看到原因。
        """
        try:
            plugins = self.api._app.plugin_manager._plugins
        except Exception as exc:                       # noqa: BLE001
            return False, f"取插件列表失败：{exc}"
        target = plugins.get("org.cslblog.betterautomations") if hasattr(plugins, "get") else None
        if target is None:
            return False, "本机没装（或没启用）「更好的自动化」"
        if not hasattr(target, "playBanner"):
            return False, "「更好的自动化」版本过旧，缺 playBanner 接口"
        try:
            if target.playBanner(text, duration):
                logger.info(f"[ClassSync] 远程横幅已显示：{len(text)} 字，{duration}s")
                return True, "横幅已显示"
            return False, "横幅未能显示"
        except Exception as exc:                       # noqa: BLE001
            logger.warning(f"[ClassSync] 调用横幅失败: {exc}")
            return False, f"调用横幅失败：{exc}"

    def _read_current_schedule_dict(self) -> Optional[dict]:
        """读“用户自己的课表”，返回 (课表名, 数据)；失败返回 None。

        本地可能同时存在两套课表：下发的 `_sync` 和用户原来的。
        默认读“正在使用”的那套，但当正在使用的就是 `_sync` 时，
        改读首次接管前记下的原课表，避免把我们自己下发的内容又传回后台。
        """
        try:
            items = self.api.schedulemanagement.list() or []
            if not items:
                return None

            by_name = {str(i.get("name")): i for i in items}
            managed = self._config.managed_schedule_name or "_sync"
            active = self._current_schedule_name()
            baseline = self._config.baseline_schedule_name or ""

            candidates = []
            if active and active in by_name:
                candidates.append(active)
            if active == managed and baseline and baseline in by_name:
                # 正在用的是 _sync，优先回退到原课表
                candidates.insert(0, baseline)
            if baseline and baseline in by_name:
                candidates.append(baseline)
            for name in by_name:
                if name != managed:
                    candidates.append(name)
            seen = set()
            for name in candidates:
                if name in seen:
                    continue
                seen.add(name)
                data = self._load_schedule_file(by_name[name])
                if data is not None:
                    return {"name": name, "data": data}
            return None
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[ClassSync] 读取本机课表失败: {exc}")
            return None

    @staticmethod
    def _load_schedule_file(item: dict) -> Optional[dict]:
        try:
            path = Path(str(item.get("path", "")))
            if not path.is_file():
                return None
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else None
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[ClassSync] 课表文件读取失败: {exc}")
            return None

    # ------------------------------------------------------------ 插件安装（半自动）
    def _stage_package(
        self, package_id: str, expected_sha: str = "", url: str = ""
    ) -> tuple[bool, str]:
        """下载 + 校验 + 解压到 plugins/.staging。**不生效**，等本机确认。

        后台下发了 url 时直接从那边（插件广场）下载，不绕服务器中转；
        两条路最后都要过 sha256 比对。
        """
        if not package_id:
            return False, "缺少包 id"
        if not self._config.paired:
            return False, "设备未绑定，无法下载"

        direct = bool(url)
        try:
            if direct:
                blob = self._client().fetch_package_url(url)
            else:
                blob = self._client().fetch_package(package_id)
        except Exception as exc:  # noqa: BLE001
            if not direct:
                return False, f"下载失败：{exc}"
            # 直连失败（校园网挡了外网）就回落到服务器中转
            try:
                blob = self._client().fetch_package(package_id)
            except Exception as exc2:  # noqa: BLE001
                return False, f"直连下载失败：{exc}；回落到服务器也失败：{exc2}"
        if not blob:
            return False, "下载到的包是空的"

        actual = hashlib.sha256(blob).hexdigest()
        if expected_sha and actual.lower() != str(expected_sha).lower():
            return False, "包校验失败（sha256 不匹配），已丢弃"

        root = self._plugins_dir()
        staging_root = root / ".staging"
        target = staging_root / f"pkg-{re.sub(r'[^A-Za-z0-9._-]', '_', package_id)}"
        try:
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            target.mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            return False, f"创建暂存目录失败：{exc}"

        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as zf:
                entries = [i for i in zf.infolist() if not i.filename.endswith("/")]
                if len(entries) > 2000:
                    return False, "包内文件过多，已拒绝"
                base = str(target.resolve()) + os.sep
                for info in entries:
                    resolved = str((target / info.filename).resolve())
                    if not resolved.startswith(base):
                        return False, f"包内路径非法：{info.filename}"
                zf.extractall(target)
        except zipfile.BadZipFile:
            return False, "不是合法的插件包"
        except Exception as exc:  # noqa: BLE001
            return False, f"解压失败：{exc}"

        manifest = target / "cwplugin.json"
        if not manifest.is_file():
            subdirs = [d for d in target.iterdir() if d.is_dir()]
            if len(subdirs) == 1 and (subdirs[0] / "cwplugin.json").is_file():
                target = subdirs[0]
                manifest = target / "cwplugin.json"
        if not manifest.is_file():
            return False, "包内没有 cwplugin.json"

        try:
            meta = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return False, "cwplugin.json 不是合法 JSON"

        pid = str(meta.get("id") or "")
        version = str(meta.get("version") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", pid or ""):
            return False, "包内插件 id 非法"
        if pid.startswith("builtin."):
            return False, "内置插件包不允许安装"
        if pid == PLUGIN_ID:
            return False, "不能用远程安装覆盖本插件，请在本机处理"

        record = {
            "package_id": package_id,
            "plugin_id": pid,
            "name": str(meta.get("name") or pid),
            "version": version,
            "staging": str(target),
            "sha256": actual,
            "size": len(blob),
            "staged_at": datetime.now().isoformat(timespec="seconds"),
        }
        self._config.pending_install = json.dumps(record, ensure_ascii=False)
        self._save_config()
        self._notify(
            "有插件等待安装",
            f"{record['name']} v{version} 已下载校验。打开「课表同步」设置页最下面的「远程安装」点安装才会生效。",
        )
        return True, f"已下载并校验 {pid} v{version}，等待在本机确认安装"

    def _notify(self, title: str, message: str) -> None:
        if self._provider is None:
            return
        try:
            self._provider.push(
                level=1, title=title, message=message, duration=12000, closable=True
            )
        except Exception:  # noqa: BLE001
            pass

    def _pending_install_text(self) -> str:
        raw = self._config.pending_install or ""
        if not raw:
            return ""
        try:
            rec = json.loads(raw)
            return f"{rec.get('name') or rec.get('plugin_id')} v{rec.get('version') or '?'}"
        except Exception:  # noqa: BLE001
            return ""

    @Slot(result=str)
    def getPendingInstall(self) -> str:
        return self._pending_install_text()

    @Slot(result=str)
    def doInstallPending(self) -> str:
        raw = self._config.pending_install or ""
        if not raw:
            return "没有待安装的插件"
        try:
            rec = json.loads(raw)
        except Exception:  # noqa: BLE001
            self._config.pending_install = ""
            return "待安装记录损坏，已清除"

        pid = str(rec.get("plugin_id") or "")
        src = Path(str(rec.get("staging") or ""))
        root = self._plugins_dir()
        if not pid or not src.is_dir():
            self._config.pending_install = ""
            return "暂存目录已不存在，请重新下载"

        # 只能在 plugins/.staging 下，避免任意目录被移进插件目录
        try:
            if root.resolve() not in src.resolve().parents:
                return "暂存路径非法，已拒绝"
        except Exception:  # noqa: BLE001
            return "暂存路径无法校验，已拒绝"

        dest = root / pid
        backup_root = root / ".backups"
        stamp = time.strftime("%Y%m%d-%H%M%S")
        moved_to = None
        try:
            backup_root.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                moved_to = backup_root / f"{pid}-{stamp}"
                shutil.move(str(dest), str(moved_to))
            shutil.move(str(src), str(dest))
        except Exception as exc:  # noqa: BLE001
            try:
                if moved_to and moved_to.exists() and not dest.exists():
                    shutil.move(str(moved_to), str(dest))
            except Exception:  # noqa: BLE001
                pass
            return f"安装失败：{exc}"

        self._set_plugin_enabled(pid, True)
        self._config.pending_install = ""
        self._save_config()
        self.configChanged.emit()
        return f"已安装 {rec.get('name') or pid} v{rec.get('version') or '?'}，请重启 Class Widgets 生效"

    @Slot(result=str)
    def doDiscardPending(self) -> str:
        """用户拒绝安装：删掉暂存目录，清空待安装记录。"""
        raw = self._config.pending_install or ""
        if not raw:
            return "没有待安装的插件"
        try:
            rec = json.loads(raw)
        except Exception:  # noqa: BLE001
            rec = {}
        staged = Path(str(rec.get("staging") or ""))
        root = self._plugins_dir()
        try:
            if staged.is_dir() and root.resolve() in staged.resolve().parents:
                shutil.rmtree(staged, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        name = rec.get("name") or rec.get("plugin_id") or "插件"
        self._config.pending_install = ""
        self._save_config()
        self.configChanged.emit()
        return f"已放弃安装 {name}"

    # ------------------------------------------------------------ 插件清单
    def _plugins_dir(self) -> Path:
        return portable.current_location().work_dir / "plugins"

    def _enabled_container(self):
        """返回可写的“启用列表”容器，外加当前列表。失败返回 (None, None)。

        CW2 的全局配置有两套访问方式（pydantic 属性 / .data 字典），
        不确定哪套可写，就按能用的那套走。
        """
        try:
            mgr = self.api.globalconfig.configs
        except Exception:
            return None, None
        try:
            plugins_obj = mgr.plugins
            return plugins_obj, list(plugins_obj.enabled or [])
        except Exception:
            pass
        try:
            data = mgr.data
            plugins_dict = data.setdefault("plugins", {})
            return plugins_dict, list(plugins_dict.get("enabled") or [])
        except Exception:
            return None, None

    def _save_global_config(self) -> None:
        self.api.globalconfig.configs.save()

    def _plugins_snapshot(self) -> list[dict]:
        """扫描已装插件清单（只读信息，不执行任何插件代码）。"""
        try:
            root = self._plugins_dir()
            if not root.is_dir():
                return []

            container, enabled_list = self._enabled_container()
            enabled_known = enabled_list is not None
            enabled = set(str(x) for x in (enabled_list or []))

            items: list[dict] = []
            for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                manifest = entry / "cwplugin.json"
                meta: dict = {}
                if manifest.is_file():
                    try:
                        loaded = json.loads(manifest.read_text(encoding="utf-8"))
                        meta = loaded if isinstance(loaded, dict) else {}
                    except Exception:  # noqa: BLE001
                        meta = {}
                pid = str(meta.get("id") or entry.name)
                items.append({
                    "id": pid,
                    "name": str(meta.get("name") or pid)[:80],
                    "version": str(meta.get("version") or "")[:40],
                    "enabled": (pid in enabled) if enabled_known else None,
                    "bundled": pid.startswith("builtin."),
                    "has_ui": bool(meta.get("custom_plugin_page") or meta.get("ui")),
                })
                if len(items) >= 60:
                    break
            return items
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[ClassSync] 读取插件清单失败: {exc}")
            return []

    def _set_plugin_enabled(self, plugin_id: str, enabled: bool) -> tuple[bool, str]:
        if not plugin_id:
            return False, "缺少插件 id"
        if plugin_id.startswith("builtin."):
            return False, "内置插件不允许操作"
        container, current = self._enabled_container()
        if container is None or current is None:
            return False, "读取全局配置失败"

        names = set(str(x) for x in current)
        if enabled:
            names.add(plugin_id)
        else:
            names.discard(plugin_id)
        new_list = sorted(names)

        try:
            if isinstance(container, dict):
                container["enabled"] = new_list
            else:
                container.enabled = new_list
            self._save_global_config()
        except Exception as exc:  # noqa: BLE001
            return False, f"写入配置失败：{exc}"

        return True, (
            f"已启用 {plugin_id}" if enabled else f"已禁用 {plugin_id}"
        ) + "，重启后生效"

    def _uninstall_plugin(self, plugin_id: str) -> tuple[bool, str]:
        if not plugin_id:
            return False, "缺少插件 id"
        if plugin_id.startswith("builtin."):
            return False, "内置插件不允许卸载"
        if plugin_id == PLUGIN_ID:
            return False, "不能远程卸载本插件，请在本机手动处理"

        root = self._plugins_dir()
        target = root / plugin_id
        if not target.is_dir():
            # 目录名可能不等于 id，按清单逐个找
            for entry in root.iterdir():
                manifest = entry / "cwplugin.json"
                if manifest.is_file():
                    try:
                        if str(json.loads(manifest.read_text(encoding="utf-8")).get("id")) == plugin_id:
                            target = entry
                            break
                    except Exception:  # noqa: BLE001
                        continue
        if not target.is_dir():
            return False, f"找不到插件目录：{plugin_id}"

        # 先移出启用列表，再搬到 .backups（可恢复，不真删）
        ok_enable, msg_enable = self._set_plugin_enabled(plugin_id, False)

        backup_root = root / ".backups"
        backup_root.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = backup_root / f"{target.name}-{stamp}"
        try:
            shutil.move(str(target), str(dest))
        except Exception as exc:  # noqa: BLE001
            return False, f"移动到备份目录失败：{exc}"

        note = "" if ok_enable else f"（{msg_enable}）"
        return True, f"已卸载 {plugin_id}，备份在 plugins/.backups/{dest.name}{note}，重启后生效"

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

    def _save_config(self) -> None:
        try:
            self.api.config.save()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[ClassSync] 保存配置失败: {exc}")

    def _set_error(self, message: str) -> None:
        text = str(message)[:500]
        self._config.last_error = text
        self._config.last_message = text[:200]
        self._save_config()
        self.configChanged.emit()
        self.syncStatusChanged.emit("error", text)