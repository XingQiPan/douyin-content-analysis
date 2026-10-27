// 分析提示词（按 docs/reference-workflow.md 提取的不一书方法论校准：
// 重点拆解定位/选题/钩子/结构/复盘五个维度，并把评论区洞察转成可执行选题）。

export const VIDEO_ANALYST_SYSTEM = `你是资深抖音内容策略分析师，长期做爆款拆解与账号增长咨询。
你会收到一个抖音视频的完整资料：文案、发布数据、口播转写稿、高赞评论。
参考分析框架（来自头部 AI 赛道博主的不一书方法论）：
- 定位：内容属于哪个细分赛道，和同类账号的差异化在哪
- 选题：选题击中了什么受众痛点，为什么现在发能拿到流量
- 钩子：开头 3 秒如何留人（悬念/反差/利益点/身份认同）
- 结构：口播的结构编排（时间线拆解），节奏与信息密度
- 复盘：数据表现与内容的对应关系，评论区透露的需求
输出必须是严格的 JSON（不要 markdown 代码块包裹），中文内容。`;

export function videoAnalystPrompt({ video, blogger, statsContext, transcript, comments, topN }) {
  const commentLines = comments
    .map((c, i) => `${i + 1}. [赞${c.digg}${c.replyCount ? ` 回复${c.replyCount}` : ''}] ${c.nickname}: ${c.content}`)
    .join('\n');

  return `# 视频资料

## 基本信息
- 博主：${blogger?.nickname || '未知'}${blogger?.followerCount ? `（粉丝 ${blogger.followerCount}）` : ''}
- 标题/文案：${video.title || '（无）'}
- 发布时间：${video.create_time ? new Date(video.create_time * 1000).toLocaleString('zh-CN') : '未知'}
- 时长：${video.duration_sec || '?'} 秒
- 数据：点赞 ${video.digg ?? '?'} | 评论 ${video.comment_count ?? '?'} | 分享 ${video.share ?? '?'} | 收藏 ${video.collect ?? '?'} | 播放 ${video.play ?? '未公开'}
${statsContext ? `- 对比该博主近 30 天均值：${statsContext}` : ''}

## 口播转写稿（whisper 转写，可能有同音字错误）
"""
${transcript || '（无转写稿，可能为图文/纯音乐视频）'}
"""

## 高赞评论 TOP ${comments.length}
${commentLines || '（无评论）'}

# 任务

请完成全方位拆解，输出 JSON，字段如下：
{
  "summary": "80字以内，视频核心内容概述",
  "topic": {
    "niche": "所属细分赛道",
    "audience": "目标受众画像",
    "pain_point": "击中的痛点/需求",
    "why_now": "为什么这个时点发能起量"
  },
  "hook": {
    "first_3s": "开头3秒的原话/画面描述",
    "type": "钩子类型（悬念/反差/利益点/身份认同/热点等）",
    "analysis": "为什么有效或无效"
  },
  "structure": [
    { "time": "0:00-0:20", "part": "段落主题", "purpose": "该段在整条视频中的作用" }
  ],
  "viral_elements": ["爆款要素（逐条列出：情绪价值/信息密度/互动引导/人设强化等，附原文证据）"],
  "comment_insights": {
    "pain_points": ["评论反映的受众痛点"],
    "needs": ["观众明确表达的需求/求教程"],
    "controversies": ["争议点（如有）"],
    "topic_ideas": ["由评论区提炼的 3-5 个可直接拍的新选题"]
  },
  "data_rating": {
    "score": 7,
    "level": "爆款/优秀/良好/一般",
    "reason": "结合互动率和博主历史水平评价"
  },
  "reusable_playbook": ["这条视频可以被复用的方法论（可迁移的做法）"],
  "suggestions": ["给该博主或模仿者的 3 条具体改进/复刻建议"]
}`;
}

export const SYNTHESIS_SYSTEM = `你是内容分析团队的主笔。多位分析师用同一框架拆解了同一条抖音视频，你会收到他们的 JSON 报告。
请去伪存真、交叉印证，输出一份更精炼的综合报告（Markdown，中文）。分歧处明确指出"某模型认为…另一模型认为…"。`;

export function synthesisPrompt({ video, blogger, reports }) {
  const body = reports
    .map((r, i) => `## 分析师${i + 1}（${r.model}）\n${typeof r.content === 'string' ? r.content : JSON.stringify(r.content)}`)
    .join('\n\n');
  return `视频：${video?.title || ''}（博主：${blogger?.nickname || ''}）

${body}

请输出综合分析报告，结构：
1. 一句话结论
2. 选题与受众（共识 + 分歧）
3. 钩子与结构拆解（融合各版本的最好解读）
4. 爆款要素清单（去重合并，按重要性排序）
5. 评论区洞察 → 可拍的新选题（标注几个模型都提到的选题）
6. 数据评价与可复用方法论
7. 三条最值得立即执行的建议`;
}
