# HIKARI NEWS

面向游戏制作学生的情报收集系统。Claude 的定时云端任务每天早晚各运行一次：自己上网研究，把值得读的内容用日文整理好，推送到 Discord，并放到需要批准才能浏览的网站上。

```
Claude 定时任务（日本时间 8:07 / 20:07）
  └─ 按 RESEARCH.md 执行
       1. python radar.py context     今天的任务 + 已推送过的链接
       2. python radar.py community   社区热门线索（HN / Reddit / Qiita / Zenn / Bluesky）
       3. AI 自主研究（WebSearch / WebFetch）→ out/results.json（日文）
       4. python radar.py publish     → Discord + Firestore
网站（Firebase Hosting）
  Google 登录 → 浏览申请 → 管理员批准 → 浏览内容
```

## 内容分类

| | 月 | 火 | 水 | 木 | 金 | 土 | 日 |
|---|---|---|---|---|---|---|---|
| 朝 | 💬SNS・コミュニティ + 📚技術 | 💬 + 🤖AI | 💬 + 📚 | 💬 + 🤖 | 💬 + 📚 | 💬 + 🤖 | 💬 + 🤖 |
| 夜 | 🎯チャンス | 🎮業界 | 🛠️AI活用 | 🎯チャンス | 🎮業界 | 🛠️AI活用 | 🎮業界 |

排班、关注关键词和社区来源都在 `config.json` 里设置，研究方法写在 `RESEARCH.md` 里。

## 文件说明

| 文件 | 作用 |
|---|---|
| `RESEARCH.md` | 给定时任务里的 Claude 看的研究说明书 |
| `config.json` | 分类、排班、关注关键词、社区来源 |
| `radar.py` | 工具脚本：context / community / check / publish |
| `collectors.py` | 社区热门内容的收集 |
| `store.py` | Firestore 读写（本地测试时用 `local_data.json`） |
| `public/` | 网站（Firebase Hosting） |
| `firestore.rules` | 数据库安全规则：只有批准的用户才能读取 |
| `docs/SETUP.md` | **设置指南（从这里开始）** |

## 本地测试

```
pip install -r requirements.txt
python radar.py context
python radar.py community
python radar.py publish samples/results.sample.json --dry-run
```

没有设置 Firebase 密钥时，数据会保存到本地的 `local_data.json`。
运行 `python -m http.server 8000` 后，打开 http://localhost:8000/public/ ，就能用演示模式查看网站。
