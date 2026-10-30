# 课表同步（ClassSync）

Class Widgets 2 插件。从自建服务器（Cloudflare Worker）拉取课表，落地到独立课表 `_sync`，后台可实时查看各机器状态、手动发布课表。

## 特性

- **手动发布才生效**：后台改完课表必须点「发布」，设备下次同步才拿到新版本。
- **避开上课时间**：正在上课时收到新课表会先挂起，等下一个课间自动切换，不会在上课中途跳变。
- **不碰原课表**：下发的课表落在独立的 `_sync` 课表里，随时可以手动切回原课表。
- **便携版切换**：一键把数据目录从 `%LOCALAPPDATA%\Class_Widgets_2` 搬到程序目录 `data\`（配合冰点还原的机器，把程序装在 D 盘即可让数据免于还原）。
- **实时状态**：上报「当前课程 + 绝对结束时刻」，后台用浏览器本地时钟倒计时，看起来是实时的，不依赖轮询频率。

## 安装

把整个插件目录放到：

```
<数据目录>\plugins\org.cslblog.classsync\
```

数据目录：

- 便携版：`<Class Widgets 2 安装目录>\data\plugins\`
- 普通安装：`%LOCALAPPDATA%\Class_Widgets_2\plugins\`

然后在 Class Widgets 2 → 设置 → 插件 里启用「课表同步」。

## 使用

1. 打开后台 `https://classsync.cslblog.dpdns.org`，用管理密钥登录。
2. 点「生成配对码」，得到 8 位一次性配对码。
3. 在插件设置页填服务器地址、设备名称、配对码，点「绑定」。
4. 绑定成功后插件会自动同步，之后每 120 秒一次（间隔可在后台调整）。
5. 在后台「编辑课表」里粘贴课表 JSON → 「格式化校验」→「保存草稿」→「发布到设备」。
6. 设备下次同步拿到新版本；如果当时正在上课，会等到课间再切换。

## 服务器

自建 Cloudflare Worker + D1，源码在同仓库 `worker/` 目录。

## 依赖

只用 Class Widgets 2 运行时自带的东西（PySide6、pydantic、loguru、certifi），HTTP 用标准库 `urllib`，不需要额外安装。

## 数据目录切换说明

安装目录下存在名为 `PORTABLE` 的空文件时，Class Widgets 2 会把数据写到 `<安装目录>\data`，否则写到 `%LOCALAPPDATA%\Class_Widgets_2`。

「切换到便携版」会：

1. 复制现有数据到 `<安装目录>\data`（跳过 `cache`、`temp`、`plugins`）
2. 校验目标目录里 `configs` 存在
3. 写 `PORTABLE` 空文件

三步都成功后才会提示重启。原用户目录**不会删除**，确认无问题后可自行清理。

> 冰点还原的机器：先把 Class Widgets 2 装到 D 盘，再切便携版，然后重启。不要在 C 盘切完等重启——会被还原掉。
