# HIKARI NEWS

面向游戏制作学生的情报收集系统。每天 3 次，由 Claude 自己上网研究，把值得读的内容用日文整理好，每一批发成一个 Discord 论坛帖子，同时放到需要批准才能浏览的网站上。

```
🕵️ 研究端：Claude 定时任务（日本时间 9:30 / 16:30 / 21:30，网络全开，没有任何密钥）
     按 RESEARCH.md 执行：
       python3 radar.py context      这一批的任务 + 已推送过的链接（来自 state/published.json）
       python3 radar.py community    社区热门线索（HN / Qiita / Zenn / Bluesky）
       AI 自主研究（WebSearch / WebFetch）→ out/results.json（日文）
       python3 radar.py submit       → 推送到 claude/inbox-… 分支
          ↓
🏢 发布端：GitHub Actions（10:05〜 / 17:05〜 / 22:05〜，密钥在 GitHub Secrets 里，不读网页）
       python radar.py publish-pending
         → Discord 论坛帖子（一批 = 一个帖子）→ Firestore → 更新 state/published.json
          ↓
🌐 网站（Firebase Hosting）：Google 登录 → 浏览申请 → 管理员批准 → 浏览内容
```

## 每天的帖子

| 发帖时间 | 内容 |
|---|---|
| 10:00 | 🤖 AIトレンド + 🎮 ゲーム業界（+ ⏰ 7 天 / 3 天 / 当天的截止提醒） |
| 17:00 | 📚 技術・学習 + 🛠️ AI活用 |
| 22:00 | 💬 SNS・コミュニティ（+ 周一、周四有 🎯 チャンス情報） |
| 周日 22:00 | 📅 今週のまとめ（一周最值得看的 5 条 + 两周内的截止日期） |

运行结果、错误和新的浏览申请会发到 `#bot-log` 频道。

## 文件说明

| 文件 | 作用 |
|---|---|
| `RESEARCH.md` | 给研究端 Claude 看的研究说明书 |
| `config.json` | 分类、时段、关注关键词、社区来源 |
| `radar.py` | 工具脚本（研究端：context / community / check / submit；发布端：publish-pending） |
| `collectors.py` | 社区热门内容的收集 |
| `store.py` | Firestore 读写 |
| `state/published.json` | 已发布过的内容（去重、截止提醒、每周汇总用），由发布端自动更新 |
| `.github/workflows/publish.yml` | 发布端（GitHub Actions） |
| `public/` | 网站（Firebase Hosting） |
| `firestore.rules` | 数据库安全规则：只有批准的用户才能读取 |
| `docs/SETUP.md` | **设置指南** |

## 本地测试

```
pip install -r requirements.txt
python radar.py context
python radar.py check samples/results.sample.json
```
