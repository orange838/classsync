# ClassSync

Class Widgets 2 的**课表同步**方案：一个跑在 Cloudflare Workers + D1 上的轻量服务端，
加上一个 CW2 插件作为被控端。用于把课表从自建服务器手动下发到多台机器，
并实时查看各机器状态。

> 与插件广场上的「集控」插件不同：ClassSync 不依赖其内网/公网连接方案，
> 是独立实现，绑定界面参考了集控的排版风格。

## 目录结构

```
classsync/
├── .github/workflows/
│   └── release.yml          打 tag 自动打包发布插件
├── worker/                  Cloudflare Workers 服务端（JS，零构建依赖）
│   ├── src/
│   │   ├── index.js         原生路由
│   │   ├── admin.js         后台接口（登录/草稿/发布/指令/设置）
│   │   ├── adminHtml.js     单页深色后台
│   │   ├── device.js         设备端接口（配对/同步/解绑）
│   │   ├── db.js            D1 读写封装
│   │   └── util.js          工具函数
│   ├── migrations/
│   │   └── 0001_init.sql    建表脚本
│   └── wrangler.toml
└── plugin/                  CW2 插件（Python，仅标准库 + PySide6）
    ├── main.py              插件主体
    ├── cwplugin.json        插件元数据
    ├── _classsync/          内部模块（独立包，避免污染 sys.path）
    ├── qml/SyncSettings.qml 设置页
    └── icon.png
```

## 工作方式

```
┌─────────────┐   手动发布课表 / 下发指令   ┌──────────────────┐
│  浏览器后台  │ ─────────────────────────► │                  │
└─────────────┘                            │  Cloudflare      │
                                           │  Worker + D1     │
┌─────────────┐   轮询拉取 + 上报状态       │                  │
│  CW2 插件   │ ◄────────────────────────► │                  │
│ (家里/班级) │                            └──────────────────┘
└─────────────┘
```

- **机器只拉不推**：设备端定时轮询（默认 120 秒），上报运行状态并申领新课表。
- **发布才生效**：后台改动先存草稿，手动点「发布」才产生新版本。
- **避开上课**：下发时若正在上课，先把课表挂起，等下一个课间再切换。
- **落地为独立课表**：写到 `_sync` 这份课表里，**不动** 用户原本的课表文件。
- **便携版切换**：冰点还原机器可一键把数据目录切到安装盘（D 盘）。

## 部署

### 1. 服务端

```bash
cd worker
npm install

# 创建 D1 数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create classsync

# 建表（远程）
npx wrangler d1 execute classsync --remote --file=./migrations/0001_init.sql

# 设置后台管理密钥
npx wrangler secret put ADMIN_KEY

# 部署
npx wrangler deploy
```

> `*.workers.dev` 在部分网络下会被 DNS 污染，建议在
> Cloudflare 控制台的 **Workers → 设置 → 域和路由 → 自定义域** 里
> 绑定一个**子域名**（例如 `classsync.example.com`），不要占用顶级域名。

### 2. 插件

把 `plugin/` 下的全部文件复制到 CW2 的插件目录：

- 普通安装：`%LOCALAPPDATA%\Class_Widgets_2\plugins\org.cslblog.classsync\`
- 便携版：`<CW2 安装目录>\data\plugins\org.cslblog.classsync\`

然后在 CW2 的 **设置 → 插件** 里启用「课表同步」。

### 3. 配对

1. 打开后台，用 `ADMIN_KEY` 登录
2. 点「生成配对码」，拿到 6 位码
3. 在插件设置页填入服务器地址、设备名称、配对码，点「绑定」

## 自动部署服务端

仓库已在 Cloudflare 控制台绑定 Git 集成（Workers → classsync → 设置 → 构建）：

- 仓库 `orange838/classsync`，生产分支 `main`
- 根目录填 `worker`，部署命令用默认的 `npx wrangler deploy`
- 构建命令留空（服务端是零构建的原生 JS）

所以**只要推送到 `main`，Cloudflare 就会自动构建并上线 Worker**，
不用本地跑 `wrangler deploy`。构建失败时线上会保持上一个可用版本。

> 注意：CF 的 Git 集成只监听分支推送，**打 tag 不会触发 Worker 部署**；
> tag 触发的是下面「自动发布插件」里的插件打包流程。

## 自动发布插件

仓库已配置好 GitHub Actions，打标签即可自动打包并发布到
[Class Widgets 插件广场](https://plaza.cw.rinlit.cn/)。

### 一次性准备

1. 在 [插件广场控制台](https://plaza.cw.rinlit.cn/console) 注册插件 ID
   `org.cslblog.classsync`，并创建发布令牌
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里
   新建名为 `CWPT_TOKEN` 的 Secret，填入令牌

### 发一个版本

```bash
git tag v0.1.0
git push origin v0.1.0
```

标签必须是 `v主版本.次版本.修订号`（只支持数字，如 `v0.1.0`）。

工作流会依次：

1. 校验标签格式，把版本号同步进 `plugin/cwplugin.json`
2. 用 `cw-plugin-pack` 生成 `org.cslblog.classsync.cwplugin` 与 `.zip`
3. 解包校验产物里的清单、入口文件和版本号
4. 用 `cw-plugin-publish` 发布到插件广场（没配 `CWPT_TOKEN` 则跳过，只出 Release）
5. 创建 GitHub Release 并挂上两个包

也可以在 Actions 页面手动触发 `Release Plugin`，输入标签名发布。

## 后台功能

- 设备列表：在线状态、当前课程、剩余时间倒计时、课表版本对比、便携版标记
- 课表编辑：JSON 编辑器 → 保存草稿 → 发布
- 指令下发：立即同步 / 上传本机课表 / 切换便携版 / 重启应用
- 设置：轮询间隔（60–600 秒）

## 安全

- 后台登录：`ADMIN_KEY` 换取的 Cookie（`sha256("classsync:" + ADMIN_KEY)`）
- 设备鉴权：配对时下发的一次性 `device_token`
- 密钥一律通过 `wrangler secret put` 设置，**不写进仓库**
