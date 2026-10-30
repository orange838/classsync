"""便携版（便携模式）检测与切换。

Class Widgets 2 的判定逻辑（来自 src/core/storage/directories.py）：

    INSTALL_PATH   = 主程序所在目录
    PORTABLE_PATH  = INSTALL_PATH / "PORTABLE"      # 这是个文件（空文件即可）
    USER_WORK_PATH = platformdirs.user_data_path("Class_Widgets_2")   # %LOCALAPPDATA%
    PORTABLE_WORK_PATH = INSTALL_PATH / "data"

    WORK_PATH = PORTABLE_WORK_PATH if PORTABLE_PATH.is_file() else USER_WORK_PATH

也就是说：安装目录下存在名为 PORTABLE 的**文件**就走便携模式，数据落在
安装目录的 data 子目录。安装目录在 D 盘，就能躲开 C 盘冰点还原。
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

PORTABLE_MARKER = "PORTABLE"
DATA_SUBDIR = "data"


@dataclass
class DataLocation:
    install_dir: Path
    work_dir: Path
    portable: bool

    @property
    def mode_text(self) -> str:
        return "便携版" if self.portable else "用户目录"


def install_dir() -> Path:
    """主程序所在目录。"""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        # macOS .app 内部结构单独处理
        if (
            exe.parent.name == "MacOS"
            and exe.parent.parent.name == "Contents"
            and exe.parent.parent.parent.suffix == ".app"
        ):
            return exe.parent.parent.parent.parent
        return exe.parent
    # 开发模式下插件跑在主程序里，sys.executable 仍是主程序
    return Path(sys.executable).resolve().parent


def user_data_dir() -> Path:
    """非便携模式的数据目录（%LOCALAPPDATA%\\Class_Widgets_2）。"""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "Class_Widgets_2"


def current_location() -> DataLocation:
    inst = install_dir()
    marker = inst / PORTABLE_MARKER
    portable = marker.is_file()
    work = inst / DATA_SUBDIR if portable else user_data_dir()
    return DataLocation(install_dir=inst, work_dir=work, portable=portable)


def can_write_install_dir() -> bool:
    """安装目录是否可写（装在 Program Files 时通常不可写）。"""
    inst = install_dir()
    probe = inst / ".classsync_write_test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception:  # noqa: BLE001
        return False


def _copy_tree(src: Path, dst: Path, skip: tuple[str, ...] = ()) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        if entry.name in skip:
            continue
        target = dst / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


@dataclass
class SwitchPlan:
    ok: bool
    message: str
    install_dir: Path
    source: Path
    target: Path
    portable: bool
    copied_files: int = 0
    copied_bytes: int = 0


def plan_switch_to_portable() -> SwitchPlan:
    """把用户目录的数据搬到安装目录 data/，并准备 PORTABLE 标记。"""
    loc = current_location()
    if loc.portable:
        return SwitchPlan(True, "当前已经是便携版，数据就在安装目录 data 下", loc.install_dir,
                          loc.work_dir, loc.work_dir, True)
    if not can_write_install_dir():
        return SwitchPlan(
            False,
            f"安装目录不可写：{loc.install_dir}\n请先把 Class Widgets 装到可写的盘（例如 D 盘）再切换便携版。",
            loc.install_dir, loc.work_dir, loc.install_dir / DATA_SUBDIR, False,
        )
    source = loc.work_dir
    target = loc.install_dir / DATA_SUBDIR
    if not source.is_dir():
        return SwitchPlan(False, f"找不到当前数据目录：{source}", loc.install_dir,
                          source, target, False)
    return SwitchPlan(True, "可以切换", loc.install_dir, source, target, False,
                      sum(len(f) for _r, _d, f in os.walk(source)), _dir_size(source))


def perform_switch_to_portable(plan: SwitchPlan, skip_plugins: bool = False) -> SwitchPlan:
    """执行切换：复制 → 校验 → 写 PORTABLE 标记。

    skip_plugins=True 时跳过 plugins 目录（插件目录里是正在运行的本插件，复制容易出问题）。
    """
    if not plan.ok:
        return plan
    try:
        skip = ("plugins", "cache", "temp") if skip_plugins else ("cache", "temp")
        _copy_tree(plan.source, plan.target, skip=skip)
        # 校验：目标目录里 configs 必须存在
        if not (plan.target / "configs").is_dir():
            return SwitchPlan(False, "复制后校验失败：目标目录缺少 configs", plan.install_dir,
                              plan.source, plan.target, False)
        marker = plan.install_dir / PORTABLE_MARKER
        marker.write_text("", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return SwitchPlan(False, f"切换失败：{exc}", plan.install_dir, plan.source,
                          plan.target, False)
    return SwitchPlan(
        True,
        f"已切换到便携版\n数据目录：{plan.target}\n重启 Class Widgets 后生效。\n"
        f"原用户目录（{plan.source}）保留未删，确认没问题后可以手动清理。",
        plan.install_dir, plan.source, plan.target, True,
    )


def switch_back_to_user_dir() -> SwitchPlan:
    """切回用户目录：删掉 PORTABLE 标记即可，数据不再被读取但保留在原处。"""
    loc = current_location()
    if not loc.portable:
        return SwitchPlan(True, "当前已经是用户目录模式", loc.install_dir,
                          loc.work_dir, loc.work_dir, False)
    marker = loc.install_dir / PORTABLE_MARKER
    try:
        marker.unlink()
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001
        return SwitchPlan(False, f"删除标记失败：{exc}", loc.install_dir,
                          loc.work_dir, user_data_dir(), True)
    return SwitchPlan(
        True,
        f"已切回用户目录模式\n数据目录：{user_data_dir()}\n重启 Class Widgets 后生效。\n"
        f"原便携数据（{loc.work_dir}）保留未删。",
        loc.install_dir, loc.work_dir, user_data_dir(), False,
    )


def describe() -> str:
    loc = current_location()
    return (
        f"{loc.mode_text}\n"
        f"程序目录：{loc.install_dir}\n"
        f"数据目录：{loc.work_dir}"
    )
