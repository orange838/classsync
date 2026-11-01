# 部署与发版

服务端是 `worker/` 下的 Cloudflare Worker + D1，插件是 `plugin/` 下的 CW2 插件。

## 目录结构

```
classsync/
├── README.md                插件说明（插件广场读取的就是这个文件）
├── icon.png                 插件图标（插件广场读取的就是这个文件）
├── docs/deploy.md           本文件：部署与发版
├── .github/workflows/
│   └── release.yml          打 tag 自动打包发布插件
├── worker/                  Cloudflare Workers 服务端（JS，零构建依赖）
│   ├── src/
│   │   ├── index.js         原生路由
│   │   ├── admin.js         后台接口（登录/草稿/发布/指令/设置）
│   │   ├── adminHtml.js     单页深色后台
│   │   ├── device.js        设备端接口（配对/同步/解绑）
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
    ├── README.md            与根目录 README.md 内容一致（打包用）
    └── icon.png             与根目录 icon.png 一致（打包用）
```

> 根目录的 `README.md` 和 `icon.png` 是插件广场抓取的资源（广场按**仓库根目录**
> 解析这两个路径）。`plugin/` 下的同名文件是插件包内部需要的副本，
> 由 CI 在打包前从根目录覆盖，平时不用手动同步。

## 部署服务端

```bash
cd worker
npm install

# 创建 D1 数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create classsync

# 建表（远程），按编号顺序全部执行
for f in ./migrations/*.sql; do
  npx wrangler d1 execute classsync --remote --file=$f
done

# 已上线的库补迁移时，只跑新增的那个
# npx wrangler d1 execute classsync --remote --file=./migrations/0005_package_chunks.sql

# 设置后台管理密钥
npx wrangler secret put ADMIN_KEY

# 部署
npx wrangler deploy
```

> 迁移清单：`0001_init` 基础表、`0002_plugins_and_login_throttle` 插件上报与登录限流、
> `0003_packages` 插件包暂存、`0004_plaza` 插件包版本与来源（用于远程升级/广场导入）、
> `0005_package_chunks` 插件包体分块存储（突破 D1 单条 1 MB 限制，上限 20 MB）。

> `*.workers.dev` 在部分网络下会被 DNS 污染，建议在 Cloudflare 控制台的
> **Workers → 设置 → 域和路由 → 自定义域** 里绑定一个**子域名**
> （例如 `classsync.example.com`），**不要占用顶级域名**。

## 自动部署服务端

仓库已在 Cloudflare 控制台绑定 Git 集成（Workers → classsync → 设置 → 构建）：

- 仓库 `orange838/classsync`，生产分支 `main`
- 根目录填 `worker`，部署命令用默认的 `npx wrangler deploy`
- 构建命令留空（服务端是零构建的原生 JS）

所以**只要推送到 `main`，Cloudflare 就会自动构建并上线 Worker**，不用本地跑
`wrangler deploy`。构建失败时线上会保持上一个可用版本。

> CF 的 Git 集成只监听分支推送，**打 tag 不会触发 Worker 部署**；
> tag 触发的是下面「自动发布插件」里的插件打包流程。

## 自动发布插件

仓库已配置好 GitHub Actions，打标签即可自动打包并发布到
[Class Widgets 插件广场](https://plaza.cw.rinlit.cn/)。

### 一次性准备

1. 在 [插件广场控制台](https://plaza.cw.rinlit.cn/console) 注册插件
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

1. 校验标签格式，把版本号同步进 `cwplugin.json`
2. 把根目录的 `README.md`、`icon.png` 覆盖进 `plugin/`（保证与广场展示一致）
3. 用 `cw-plugin-pack` 生成 `org.cslblog.classsync.cwplugin` 与 `.zip`
4. 解包校验产物里的清单、入口文件和版本号
5. 用 `cw-plugin-publish` 发布到插件广场（没配 `CWPT_TOKEN` 则跳过，只出 Release）
6. 创建 GitHub Release 并挂上两个包

也可以在 Actions 页面手动触发 `Release Plugin`，输入标签名发布。

## 插件登记信息

插件广场控制台里这几项要和仓库保持一致：

| 字段 | 值 |
| --- | --- |
| 插件 ID | `org.cslblog.classsync` |
| 仓库 | `https://github.com/orange838/classsync` |
| 分支 | `main` |
| README 路径 | `README.md`（相对仓库根目录） |
| 图标路径 | `icon.png`（相对仓库根目录） |

## 后台功能

- 设备列表：在线状态、当前课程、剩余时间倒计时、课表版本对比、便携版标记与数据目录
- 课表编辑：JSON 编辑器 / 导入本地 `school.json` → 保存草稿 → 发布
- 指令下发：请求同步 / 上传本机课表 / 切换便携版 / 重启应用
- 设置：轮询间隔（15–86400 秒，默认 30 秒）

配额参考：两台设备 24 小时全开时，30 秒间隔约 5,760 请求/天，
占 Workers 免费额度（100,000/天，**账号级共享**）的 5.8%。

## 安全

- 后台登录：`ADMIN_KEY` 换取的 Cookie（`sha256("classsync:" + ADMIN_KEY)`）
- 设备鉴权：配对时下发的一次性 `device_token`
- 密钥一律通过 `wrangler secret put` 设置，**不写进仓库**
