# 导入数据格式说明

开源版不采集平台数据，所有可视化 / AI 分析 / 雷达 / 选题 / 日报的数据都来自本地
SQLite（`data/monitor.db`），通过 `npm run import -- <file.json>` 注入。

在**私有采集版**（含完整采集层的项目）中，你可以把采集/分析好的数据导出成下面
这份 JSON，再在本开源版中导入。

## 顶层结构

```jsonc
{
  "bloggers":  [ /* 博主及其视频、评论、分析 */ ],
  "scoutRuns": [ /* 博主雷达的扫描结果跑次 */ ],
  "searchRuns":[ /* 选题分析的关键词跑次 */ ]
}
```

三个字段都可选，可只导入其中的一部分。

## bloggers 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `secUid` | string | 博主唯一标识（必填），如 `MS4wLjABAAAAxxx` |
| `nickname` | string | 昵称 |
| `signature` | string | 个性签名 |
| `avatar` | string | 头像 URL（可空） |
| `followerCount` | number | 粉丝数 |
| `videos` | array | 该博主下的视频列表 |

### videos 里的视频对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `awemeId` | string | 视频 ID（必填） |
| `title` | string | 标题 |
| `createTime` | number | Unix 秒级时间戳 |
| `durationSec` | number | 时长（秒） |
| `cover` | string | 封面 URL（可空） |
| `stats` | object | 互动数据 `{digg, comment, share, collect, play}` |
| `transcriptText` | string | 转写稿（若有，可直接驱动 AI 分析而不必转写） |
| `comments` | array | 评论列表（见下） |
| `analyses` | array | 已有的 AI 分析结果（见下，可选） |

#### comments 评论对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `cid` | string | 评论唯一 ID（必填，或省略会自动生成） |
| `nickname` | string | 评论者昵称 |
| `content` | string | 评论文本 |
| `digg` | number | 点赞数 |
| `replyCount` | number | 回复数 |
| `createTime` | number | 评论时间戳 |

#### analyses 分析对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 分析提供方 id |
| `model` | string | 模型名 |
| `kind` | string | 默认 `video`，综合结论用 `synthesis` |
| `content` | string | 分析结论文本（Markdown） |
| `status` | string | 默认 `success` |

## scoutRuns 字段（博主雷达）

```jsonc
{
  "domain": "AI 工具",         // 雷达领域
  "keywords": ["AI 工具", ...],// 搜索变体
  "blogs": [                    // 该领域扫描到的博主
    {
      "secUid": "...",
      "nickname": "...",
      "followerCount": 128500,
      "awemeCount": 320,
      "videoSamples": 20,
      "maxDigg": 100000,
      "medianDigg": 3200,       // 平均点赞
      "heatRatio": 12.5,        // 赞粉比 %
      "freshDays": 0,           // 最近更新距今天数
      "score": 86,              // 综合分 0-100
      "rating": "🚀 上升期黑马",// 评级文案
      "aiAnalysis": "{\"...\"}" // AI 分析 JSON 字符串
    }
  ]
}
```

## searchRuns 字段（选题分析）

```jsonc
{
  "keyword": "AI 做图",
  "topn": 3,
  "videos": [
    {
      "awemeId": "...",
      "title": "...",
      "author": "作者",
      "digg": 5000,
      "commentCount": 300,
      "share": 120,
      "collect": 800,
      "rank": 1,
      "analyzed": 1
    }
  ]
}
```

## 完整示例

见仓库根目录 `examples/sample.json`，可直接 `npm run import -- examples/sample.json` 体验。