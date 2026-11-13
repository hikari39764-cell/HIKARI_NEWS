# HIKARI NEWS 设置指南

按顺序做下来大约需要 1 小时。界面可能是日文或中文，两种说法都写上了。

```
① Firebase 项目          ← 控制台操作
② 网站和规则的部署        ← 在电脑上执行几条命令
③ 把自己设为管理员
④ 机器人用的密钥（低权限）
⑤ Discord 论坛频道 + Webhook
⑥ GitHub Secrets（发布端的钥匙）
⑦ Claude 的云端环境 + 定时任务（研究端）
⑧ 测试
```

---

## ① Firebase 项目

### 1-1 创建项目
1. 打开 https://console.firebase.google.com ，用 Google 账号登录。
2. 点「Firebase プロジェクトを作成 / 创建 Firebase 项目」。
3. 项目名称填 `hikari-news`。名称下方会显示**项目 ID**（例如 `hikari-news-1a2b3`），请记下来。
4. Gemini / AI 助手之类的选项可以关闭。**Google Analytics 要关闭**。
5. 点「プロジェクトを作成」，完成后点「続行」。
6. 方案保持免费的 **Spark** 即可，不需要绑定信用卡。

### 1-2 开启 Google 登录
1. 左侧菜单「構築 / 构建」→「Authentication」→「始める / 开始使用」。
2. 「ログイン方法 / Sign-in method」→「Google」→ 打开「有効にする / 启用」。
3. 支持邮箱选你自己的地址，然后保存。

### 1-3 创建 Firestore 数据库
1. 左侧「構築」→「Firestore Database」→「データベースの作成 / 创建数据库」。
2. 版本选 Standard，数据库 ID 保持 `(default)`。
3. 位置选 **asia-northeast1 (Tokyo)**。⚠️ 之后无法修改。
4. 选「本番環境モード / 生产模式」→「作成」。

### 1-4 注册网页应用
1. 左上角 ⚙️ →「プロジェクトの設定 / 项目设置」→「全般 / 常规」→ 拉到最下方「マイアプリ / 你的应用」。
2. 点 `</>`（ウェブ），昵称填 `hikari-news-web`，勾选「Firebase Hosting も設定する」，然后点「アプリを登録」。
3. 把显示出来的 `firebaseConfig` 的内容填进 `public/firebase-config.js`。这是公开信息，可以提交到 GitHub。
4. 后面的「SDK の追加」「CLI のインストール」直接点「次へ」跳过，最后点「コンソールに進む」。

---

## ② 部署网站和数据库规则

只在第一次和修改网站代码时需要做。

1. 安装 **Node.js**：在 https://nodejs.org 下载 **LTS** 版，一路「下一步」装完即可。
2. 打开 PowerShell，执行：
   ```
   cd D:\PJ\HIKARI_NEWS
   npx firebase-tools login
   ```
   浏览器会打开，用 Google 账号登录并允许授权。
3. 部署（项目 ID 已经写在 `.firebaserc` 里，不用另外指定）：
   ```
   npx firebase-tools deploy --only hosting,firestore:rules
   ```
4. 成功后会显示 `Hosting URL: https://<项目ID>.web.app`，这就是网站地址。
   把它填进 `config.json` 的 `site_url`，之后 Discord 消息末尾就会附上网站链接。

---

## ③ 把自己设为管理员

1. 打开网站，用你的 Google 账号登录。会显示「閲覧申請」画面，**不用提交**。
2. 回到 Firebase 控制台 →「Authentication」→「ユーザー / 用户」标签，复制你那一行的「**ユーザー UID**」。
3. 打开「Firestore Database」→「データ」标签 →「**コレクションを開始 / 启动集合**」。
   - コレクション ID：`admins`
   - ドキュメント ID：**粘贴你的 UID**
   - 字段：名称 `role`，类型 string，值 `owner`
   - 点「保存」。
4. 刷新网站，就能看到所有内容，还会多出「⚙️ 管理」标签页。

**之后的日常操作**：有人申请时，Discord 会收到「🙋 新しい閲覧申請」通知（在早晚的定时运行时一起发送）。到网站的「⚙️ 管理」点「承認」或「拒否」即可。

---

## ④ 机器人用的密钥（只能读写数据库的低权限账号）

机器人需要一把钥匙才能往数据库写内容。这里新建一个**只有数据库权限**的账号，万一密钥泄露，影响也有限。

1. 打开 https://console.cloud.google.com/iam-admin/serviceaccounts ，在上方选择你的 Firebase 项目。
2. 点「**サービス アカウントを作成 / 创建服务账号**」。
   - 名称：`hikari-news-bot`，然后点「作成して続行」。
   - 「ロール / 角色」搜索并选择 **Cloud Datastore ユーザー（Cloud Datastore User）**，然后点「続行」→「完了」。
3. 在列表里点刚建好的 `hikari-news-bot` →「**鍵 / 密钥**」标签 →「鍵を追加」→「新しい鍵を作成」→ 选 **JSON** →「作成」。
   - 会下载一个 `.json` 文件，这就是密钥。⚠️ **不要发给任何人，不要放进 GitHub 仓库的文件夹。**
4. 在 PowerShell 里把它转成一行文字，并复制到剪贴板（路径换成实际下载的位置）：
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\下载的文件名.json")) | Set-Clipboard
   ```
   复制好的这一长串文字，就是第 ⑥ 步要放进 GitHub Secrets 的 `FIREBASE_SERVICE_ACCOUNT_B64`。
5. 设置完成后，下载的 JSON 文件可以删除。需要时可以重新生成新的密钥。

---

## ⑤ Discord 论坛频道 + Webhook

1. 在 Discord 服务器里新建频道，类型选「**フォーラム / 论坛**」，名称例如 `📰hikari-news`。
2. 打开这个论坛频道的设置 ⚙️ →「連携サービス / 整合」→「ウェブフック / Webhook」→「新しいウェブフック」，然后点「**ウェブフック URL をコピー**」。这就是 `DISCORD_FORUM_WEBHOOK`。
3. （推荐）再建一个**只有自己能看到**的文字频道 `#bot-log`，同样建一个 Webhook。这就是 `DISCORD_LOG_WEBHOOK`。运行结果、错误和新的浏览申请会发到这里。

⚠️ 有 Webhook URL 就能往频道发消息，不要公开。

---

## 整体结构（为什么要分成研究端和发布端）

```
🕵️ 研究端：Claude 定时任务（9:30 / 16:30 / 21:30）
   ・网络全开，可以读任何网站。环境里没有任何密钥
   ・研究完成后，把结果推送到 GitHub 的 claude/inbox-… 分支
        ↓
🏢 发布端：GitHub Actions（10:05 / 10:25 / 10:45 …每批检查 3 次）
   ・密钥只放在 GitHub Secrets 里，不读任何网页
   ・只把 inbox 分支里的结果当作数据读取 → 检查 → 发 Discord 论坛帖子 → 写入 Firebase
```

AI 会读到各种网页，网页里可能藏着针对 AI 的恶意指令。因为研究端身上没有钥匙，就算 AI 被骗，也没有东西可以泄露。

---

## ⑥ GitHub Secrets（发布端的钥匙）

1. 打开 https://github.com/hikari39764-cell/HIKARI_NEWS/settings/secrets/actions
2. 点「**New repository secret**」，一个一个加上：

| Name | Secret |
|---|---|
| `DISCORD_FORUM_WEBHOOK` | 论坛频道的 Webhook URL |
| `DISCORD_LOG_WEBHOOK` | `#bot-log` 的 Webhook URL（可选） |
| `FIREBASE_SERVICE_ACCOUNT_B64` | 第 ④ 步转换出来的那一长串 |

---

## ⑦ Claude 的云端环境 + 定时任务（研究端）

需要 Claude 的 Pro 或 Max 订阅。这个功能目前是 research preview，界面可能会有变化。

### 7-1 连接 GitHub
打开 https://claude.ai/code ，按提示连接 GitHub，并允许访问 `HIKARI_NEWS` 仓库。

### 7-2 云端环境 `hikari-news`
- **网络访问**：选「**完全访问 / Full**」。研究端没有密钥，所以可以放开。
- **环境变量**：**全部删除，保持空白**。⚠️ 不要在这里放任何密钥。
- **网络密钥**：无。
- **安装脚本**：
  ```
  python3 -m pip install -q --break-system-packages --ignore-installed requests
  ```

### 7-3 定时任务
- **Repository**：`HIKARI_NEWS`。**Environment**：`hikari-news`。**Model**：Sonnet。
- **Instructions**：
  ```
  请阅读仓库根目录的 RESEARCH.md，严格按照里面的步骤完成这一批的研究并交稿（所有内容用自然的日文）。
  除了 RESEARCH.md 里写的 submit 之外，不要 commit、push 或创建 PR，也不要修改任何文件。
  ```
- **Schedule**：日本时间每天 9:30、16:30、21:30。用 UTC 的 cron 写作 `30 0,7,12 * * *`。

---

## ⑧ 测试

1. 在定时任务页面点「**Run now / 今すぐ実行**」，等它显示「✅ 已提交」。
2. 打开 https://github.com/hikari39764-cell/HIKARI_NEWS/actions →「Publish HIKARI NEWS」→「**Run workflow**」，手动运行一次发布端。
3. 检查 Discord 论坛里是否出现了新帖子，网站上是否出现了文章。

**常见问题**
- Actions 报 `没有设置 DISCORD_FORUM_WEBHOOK`：第 ⑥ 步的 Secret 名称拼错了。
- Discord 报 `HTTP 400`，且提示和 thread_name 有关：Webhook 建在了普通文字频道上，要建在**论坛频道**上。
- Firestore 报 `PERMISSION_DENIED`：第 ④ 步的角色没有选「Cloud Datastore ユーザー」。
- 网站登录后显示「読み込みに失敗しました」：第 ② 步的规则没有部署，或第 ③ 步的 UID 填错了。
- `#bot-log` 出现「バッチがまだ届いていません」：研究端没有交稿。到 https://claude.ai/code/routines 查看运行记录。

---

## 平时怎么改

| 想做的事 | 改哪里 |
|---|---|
| 改研究方向、质量标准 | `RESEARCH.md` |
| 改分类、时段排班、关注关键词、社区来源 | `config.json` |
| 改 Discord 帖子的排版 | `radar.py` 的 `build_batch_embeds` |
| 改网站外观和功能 | `public/` 目录，改完后重新执行第 ② 步的部署命令 |
| 批准或拒绝浏览申请 | 网站上的「⚙️ 管理」 |

改完后 push 到 GitHub 的 main 分支，下一次运行就会使用新内容。
