/**
 * HIKARI NEWS メール送信用の Google Apps Script（送信用 Gmail アカウントの中で動かす）
 *
 * GitHub Actions の発布端が、配信のたびにこのウェブアプリへ記事のメールを渡す。
 * このスクリプトが、送信用 Gmail から 1 人ずつメールを送る（宛先はお互いに見えない）。
 *
 * 設定：
 *   1. プロジェクトの設定 → スクリプト プロパティ に「TOKEN」を追加（長いランダムな文字列）
 *   2. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *   3. ウェブアプリの URL を GitHub Secrets の MAIL_RELAY_URL に、
 *      同じ TOKEN を MAIL_RELAY_TOKEN に登録する
 *
 * TOKEN を知らない人からの依頼は、すべて断る。
 */

function doPost(e) {
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'bad request' });
  }
  if (!token || token.length < 20 || data.token !== token) {
    return reply_({ ok: false, error: 'unauthorized' });
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
  return reply_({ ok: true, sent: sent, errors: errors, remaining: MailApp.getRemainingDailyQuota() });
}

/** エディタで一度実行して、権限の許可と送信テストをする（自分宛てにテストメールが届く） */
function test() {
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'HIKARI NEWS 送信テスト', 'このメールが届いていれば、送信の準備はできています。', { name: 'HIKARI NEWS' });
  Logger.log('テストメールを送りました：' + me + '（今日あと ' + MailApp.getRemainingDailyQuota() + ' 通）');
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
