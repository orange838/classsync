from __future__ import annotations

from ClassWidgets.SDK import ConfigBaseModel
from pydantic import Field


class ClassSyncConfig(ConfigBaseModel):
    # 连接
    server_url: str = ""
    device_id: str = ""
    device_token: str = ""
    device_name: str = ""
    paired: bool = False

    # 同步状态
    poll_interval_seconds: int = 120
    schedule_revision: int = 0
    schedule_hash: str = ""
    last_sync_time: str = ""
    last_error: str = ""
    last_message: str = ""

    # 课表落地
    managed_schedule_name: str = "_sync"       # 下发的独立课表名，不碰原课表
    applied_revision: int = 0
    pending_revision: int = 0                  # 等待课间再切换的版本
    pending_payload: dict = Field(default_factory=dict)

    # 指令回执
    pending_acks: list[dict] = Field(default_factory=list)

    # 便携版
    portable_hint_shown: bool = False
