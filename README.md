# douyin-content-analysis

抖音博主内容数据**分析与可视化框架**（开源版）。

> 开源版含**免登录视频解析与下载**能力（无需登录态、不携带账号 cookie），并提供
> 多模型 AI 拆解、博主雷达评级、选题爆款分析、每日日报 / 简报、全量可视化面板。
> **不含登录态采集**（博主主页 / 评论 / 搜索依赖登录态接口与滑块处理，留在私有版）；
> 这些维度的数据可通过 `npm run import` 从你的私有采集环境注入。

## 功能

| 视图 | 说明 |
|---|---|
| 🎥 **监控** | 博主数据仪表盘（KPI / 发布节奏 / 趋势 / 时间习惯 / 爆款榜 / 高频词）、视频详情（AI 拆解 + 评论 + 转写稿）、每日分析日报、数据增长曲线 |
| 📡 **博主雷达** | 对已导入的赛道博主做规则 + AI 综合评级（潜力 / 黑马 / 头部 / 停更等）、散点图四象限、横向对比 |
| 🔍 **选题分析** | 展示已导入的关键词爆款列表、逐条 AI 拆解、跨视频爆款规律报告 |
| ☰ **运行日志** | 全局日志实时查看 |
| ⚙️ **设置** | LLM 接口配置（多 provider 并行，任意 OpenAI 兼容端点）、监控参数、连接测试 |

**任务中心**：全局串行任务队列。**定时简报**：node-cron 调度。

## 快速开始

```bash
npm install

# 1. 配置 LLM（复制 config.example.json 为 config.json，填 OpenAI 兼容端点的 baseUrl/apiKey）
#    config.json 已被 .gitignore 忽略，不会提交

# 2. 导入数据（采集在私有版完成，导出 JSON 后注入）
npm run import -- examples/sample.json     # 体验示例数据

# 3. 启动面板
npm run web                                # http://127.0.0.1:8421
```

## 命令行

| 命令 | 说明 |
|---|---|
| `npm run import -- <file.json>` | 导入数据到本地 SQLite（字段见 `docs/import-format.md`） |
| `node src/index.js list` | 列出博主 |
| `node src/index.js enable/disable <id>` | 启停博主 |
| `npm run analyze -- <aweme_id>` | 对已导入视频补跑 AI 分析（`--force` 重跑） |
| `npm run report -- <id> [条数]` | 手动生成日报 |
| `npm run web` | 仅启动面板 |
| `npm run daemon` | 定时调度 + 面板 |
| `npm run clean` | 清理临时文件 / 日志轮转 |

> `login` / `add` / `check` 等**登录态采集**命令在开源版不可用。`analyze`/`download`
> 走**免登录**视频解析，无需登录即可下载单个视频并本地转写 / 分析。

## 数据从哪来

本开源版提供两类数据入口：

1. **免登录视频解析**（含在开源版 `src/douyin/share.js`）：粘贴分享链接或 aweme_id，
   无需登录即可解析并下载**单个公开视频**，随后本地转写 / AI 分析。适合按需看单条
   视频，不依赖任何账号 cookie。
2. **数据导入**（`npm run import -- <json>`）：博主列表、评论、雷达、选题等**要多数据集**
   维度通过 JSON 注入本地 SQLite（字段见 `docs/import-format.md`）。这些维度的原始采集
   依赖登录态接口，留在私有采集版；导出后导入即可在本开源版完整可视化。

## 配置文件

```jsonc
{
  "llm": {
    "providers": [{
      "id": "your-provider",
      "baseUrl": "http://127.0.0.1:8318/v1",   // 任意 OpenAI 兼容端点
      "apiKey": "sk-...",
      "enabled": true,
      "models": {
        "analysts": ["analyst-model-1", "analyst-model-2"], // 并行拆解
        "synthesizer": "synthesis-model"                    // 综合结论
      }
    }]
  },
  "monitor": {
    "cron": "0 9 * * *",
    "topComments": 50,
    "transcribe": { "model": "small", "maxMinutes": 15 },
    "keepVideoDays": 0
  },
  "web": { "host": "127.0.0.1", "port": 8421, "password": "" }
}
```

面板访问保护：`web.password` 填任意字符串即启用密码，适合暴露到局域网。

## AI 分析流水线（保留的核心能力）

- **多模型并行拆解**：`analysts` 配置多个模型同时分析同一视频，结果并排展示。
- **综合结论**：`synthesizer` 汇总多模型结果，交叉印证给出综合判断。
- **博主雷达评级**：规则分（赞粉比 / 爆款样本 / 活跃度等方式这）+ AI 潜力评级。
- **选题爆款规律**：同关键词多条爆款横向对比，提炼共性钩子与内容空位。

配置好 LLM 后，在面板或命令行触发 `analyze` / 雷达评级 / 简报即可。

## 本地视频转写

`src/media/transcribe.js` 保留了对**本地视频文件**做 ffmpeg 抽音 + whisper 转写的
能力（需本机装好 `ffmpeg` 与 `whisper`）。它只处理你已下载并放到本地的文件，
不涉及任何平台下载。

## 目录结构

```
src/
├─ index.js         CLI 入口（list/enable/analyze/report/web/daemon）
├─ import.js        数据导入层（开源版核心）★
├─ core/            config / db(node:sqlite) / jobs / scheduler / logger
├─ data/            数据来源适配层 —— 从本地库读取，替代采集 ★
├─ analysis/        多模型 AI 拆解 + 综合结论
├─ llm/             OpenAI 兼容多模态调用
├─ media/           本地视频 ffmpeg + whisper 转写
├─ report/          Markdown 日报生成
├─ pipeline/        monitor / scout / search / briefing / creation 编排
└─ web/             Express 面板 + 单页前端
```

## 说明

- **不含采集**：`src/data/` 下的适配层只读本地库，不访问任何平台，字面描述都标注了来源。
- 数据 / 配置 / 报告不入库：`data/`、`reports/`、`config.json` 均在 `.gitignore`。
- 转写、雷达评级、选题分析需要本机有可用的 LLM 端点与对应模型。