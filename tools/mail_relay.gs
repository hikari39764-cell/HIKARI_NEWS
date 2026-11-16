/**
 * HIKARI NEWS メール送信用の Google Apps Script（送信用 Gmail アカウントの中で動かす）
 *
 * GitHub Actions の発布端が、配信のたびにこのウェブアプリへ記事のメールを渡す。
 * このスクリプトが、送信用 Gmail から 1 人ずつメールを送る（宛先はお互いに見えない）。
 *
 * 設定：
 *   1. プロジェクトの設定 → スクリプト プロパティ に「TOKEN」を追加（20 文字以上のランダムな文字列）
 *   2. エディタで関数「test」を選んで実行 → 権限を許可（自分宛てにテストメールが届く）
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *      コードを貼り替えたときは、デプロイ → デプロイを管理 → 鉛筆 → バージョン「新バージョン」→ デプロイ
 *      （こうすると URL は変わらない）
 *   4. 「ウェブアプリ URL」（…/exec で終わる）を GitHub Secrets の MAIL_RELAY_URL に、
 *      同じ TOKEN を MAIL_RELAY_TOKEN に登録する
 *   5. 確認：ウェブアプリ URL をブラウザのシークレット ウィンドウで開くと {"ok":true,…} が表示される。
 *      Google のログイン画面が出たら、「アクセスできるユーザー」が「全員」になっていない。
 *
 * TOKEN を知らない人からの依頼は、すべて断る。
 */

var VERSION = 2;

/** ブラウザで URL を開いたときの確認用（メールは送らない） */
function doGet() {
  return reply_({ ok: true, service: 'HIKARI NEWS mail relay', version: VERSION, token_ready: token_().length >= 20 });
}

function doPost(e) {
  try {
    return reply_(handle_(e));
  } catch (err) {
    return reply_({ ok: false, error: String(err).slice(0, 200) });
  }
}

function handle_(e) {
  var token = token_();
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return { ok: false, error: 'bad request' };
  }
  if (token.length < 20 || String(data.token || '').trim() !== token) {
    return { ok: false, error: 'unauthorized' };
  }

  var list = Array.isArray(data.to) ? data.to.slice(0, 50) : [];
  var sent = 0;
  var errors = [];
  list.forEach(function (to) {
    if (typeof to !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      errors.push('invalid address');
      return;
    }
    try {
      MailApp.sendEmail({
        to: to,
        subject: String(data.subject || 'HIKARI NEWS').slice(0, 200),
        htmlBody: String(data.html || ''),
        body: String(data.text || ''),
        name: 'HIKARI NEWS'
      });
      sent++;
    } catch (err) {
      errors.push(String(err).slice(0, 120));
    }
  });
  return { ok: true, sent: sent, errors: errors, remaining: MailApp.getRemainingDailyQuota(), version: VERSION };
}

/** エディタで一度実行して、権限の許可と送信テストをする（自分宛てにテストメールが届く） */
function test() {
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'HIKARI NEWS 送信テスト', 'このメールが届いていれば、送信の準備はできています。', { name: 'HIKARI NEWS' });
  Logger.log('テストメールを送りました：' + me + '（今日あと ' + MailApp.getRemainingDailyQuota() + ' 通）');
  Logger.log(token_().length >= 20 ? 'TOKEN：OK' : 'TOKEN：まだ設定されていないか、20 文字未満です');
}

function token_() {
  return String(PropertiesService.getScriptProperties().getProperty('TOKEN') || '').trim();
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
