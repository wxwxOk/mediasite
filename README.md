# mediasite

自托管的影视发现站 + 磁力检索。TMDB 榜单聚合、豆瓣/烂番茄评分、DHT 全网磁力搜索，
外加一个管控 DHT 爬虫的 Web 控制台。

> 依赖 [bitmagnet](https://github.com/bitmagnet-io/bitmagnet)（MIT）做 DHT 抓取与内容分类。
> 本仓库提供的是**站点、爬虫管控与整套部署编排**，不是 DHT 协议的重新实现。

## 它长什么样

- **发现**：TMDB 热门/高分/趋势/正在上映等榜单，按电影、剧集、年份、类型筛选，支持收藏与打分
- **评分**：TMDB 之外补齐豆瓣与烂番茄（批量抓 + 详情页实时抓，带缓存与节流）
- **磁力**：对每个条目实时检索 DHT 索引，按做种数、分辨率、中文字幕、季集整理，标注同名噪声
- **爬虫控制台**：网页上切换爬虫启停模式、抓取档位、运行时段，实时看运行状态与网速

## 架构

三个组件，其中两个靠 **文件协议** 解耦——这是刻意的设计，让站点容器不需要任何 Docker 权限，
也不新增对外监听端口：

```
┌──────────────┐        ┌────────────────┐        ┌──────────────────┐
│   web        │        │  crawler-agent │        │  bitmagnet       │
│  (容器)      │        │  (宿主机进程)  │        │  (容器)          │
├──────────────┤        ├────────────────┤        ├──────────────────┤
│ 站点 UI/API  │        │ 每 2s 一轮收敛 │        │ DHT 爬虫         │
│ 榜单同步     │───────▶│ 改 config.yml  │───────▶│ 内容分类         │
│ 磁力检索     │ 写期望 │ 启停容器       │ docker │ GraphQL API      │
│              │◀───────│ 回写实际状态   │        │ PostgreSQL       │
└──────────────┘ 读状态 └────────────────┘        └──────────────────┘
        │                                                  ▲
        │              GraphQL 查询磁力                     │
        └──────────────────────────────────────────────────┘
```

- `data/crawler.json` — 站点写、agent 读：用户在控制台表达的**期望**状态
- `data/crawler-state.json` — agent 写、站点读：爬虫的**实际**状态

agent 是**收敛式**而非触发器：每 2 秒把实际状态拉回期望状态。因此宿主重启、容器崩溃、
有人手动 `docker compose up -d`，都会在 2 秒内被自动纠正。

## 快速开始

前置：Docker 与 Docker Compose、Node.js ≥ 20（仅 agent 需要，站点跑在容器里自带）、
一个 [TMDB](https://www.themoviedb.org/settings/api) 凭据。

```bash
git clone https://github.com/wxwxOk/mediasite /opt/mediasite
cd /opt/mediasite
```

### 1. 爬虫栈（bitmagnet + PostgreSQL）

```bash
cd crawler
cp .env.example .env      # 填入 TMDB_API_KEY
docker compose up -d bitmagnet-core postgres
```

`bitmagnet-crawler` 刻意**不**在这里启动——它由 agent 按控制台设定启停。
爬虫监听 3333（GraphQL/Web UI），PostgreSQL 只绑 `127.0.0.1:5432`。

### 2. 站点

```bash
cd ../web
cp .env.example .env
# 必填 TMDB_TOKEN；对外暴露时还要设 SITE_PASSWORD
docker compose up -d --build
```

首次启动会拉 TMDB 榜单，页面在 <http://localhost:8899>。

### 3. 爬虫控制 agent

需要能免密执行 `docker`（`sudo usermod -aG docker $USER` 后重新登录）——
**不要把密码写进脚本**。

```bash
mkdir -p ~/.config/systemd/user
cp crawler/agent/crawler-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now crawler-agent
loginctl enable-linger $USER     # 未登录时也持续运行
```

部署路径不是 `/opt/mediasite` 时，改 unit 里的 `MEDIASITE_DATA_DIR` 与 `BITMAGNET_CONFIG`。
控制台在站点的「DHT 爬虫」页。

## 目录结构

```
├── data/                    # 运行期共享目录（不提交）：SQLite、封面缓存、控制状态文件
├── web/                     # 站点：Fastify + node:sqlite
│   ├── src/
│   │   ├── scraper.js       # 榜单同步排期（热榜追新 + 轮转补旧）
│   │   ├── ratings.js       # 豆瓣 / 烂番茄抓取
│   │   ├── providers/       # 磁力来源：bitmagnet、Prowlarr，及相关性/季集/字幕解析
│   │   └── crawler.js       # 控制协议的数据层（读写上面两个 JSON）
│   └── docker-compose.yml
└── crawler/                 # DHT 爬虫栈
    ├── docker-compose.yml   # bitmagnet core / crawler / postgres
    ├── config/config.yml    # bitmagnet 配置（scaling_factor 由 agent 接管）
    ├── agent/               # 控制 agent + systemd unit
    └── tools/               # 健康检查、种子导入
```

## 配置

两处 `.env`（均已在 `.gitignore` 中）：`web/.env.example` 与 `crawler/.env.example`
列了全部变量与说明。常改的几个：

| 变量 | 位置 | 说明 |
|---|---|---|
| `TMDB_TOKEN` / `TMDB_KEY` | web | TMDB 凭据，二选一 |
| `SITE_PASSWORD` | web | 访问口令；**留空即不鉴权**，此时务必保持 `BIND_ADDR=127.0.0.1` |
| `SITE_SECRET` | web | 会话签名密钥，`openssl rand -hex 32` 生成 |
| `BIND_ADDR` | web | `0.0.0.0` 才对外，前提是已设 `SITE_PASSWORD` |
| `HTTP_PROXY` / `HTTPS_PROXY` | web | 访问 TMDB / 豆瓣需要代理时填 |
| `TMDB_API_KEY` | crawler | bitmagnet 富化用 |
| `MEDIASITE_DATA_DIR` | agent | 站点 `data/` 的绝对路径 |
| `NET_IFACE` | agent | 网速采样的网卡，默认自动取默认路由那块 |

## 免责声明

本项目是**索引与检索工具**：它不托管、不存储、不分发任何受版权保护的内容，
只查询公开的 DHT 网络与用户自行配置的索引源。

抓取 DHT 与使用磁力链接的合法性因司法辖区而异。请在部署前确认你所在地的法律，
并自行承担使用后果。请勿将其用于侵权用途。

## 许可

[MIT](LICENSE)。bitmagnet 由 [bitmagnet-io](https://github.com/bitmagnet-io/bitmagnet) 以 MIT 许可发布，
本项目通过官方镜像调用它。
