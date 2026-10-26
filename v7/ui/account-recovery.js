(function (root) {
  'use strict';
  var active = null;
  function open(options) {
    options = options || {};
    if (active) { active.querySelector('input').focus(); return; }
    if (!document.getElementById('account-recovery-style')) {
      var style = document.createElement('style'); style.id = 'account-recovery-style';
      style.textContent = '.account-recovery{font:13px/1.5 system-ui,sans-serif}.account-recovery .settings-field{display:block;font-size:13px}.account-recovery input{display:block;min-height:36px;padding:7px 9px;border:1px solid var(--line,#555);border-radius:4px;background:rgba(0,0,0,.2);color:inherit;font:inherit}.account-recovery input:focus{outline:2px solid var(--accent,#75b9df);outline-offset:1px}.account-recovery button{min-height:34px;padding:6px 12px;border:1px solid var(--line-strong,#666);border-radius:4px;background:rgba(255,255,255,.1);color:inherit;font:inherit;cursor:pointer}.account-recovery button:disabled{opacity:.5;cursor:default}.account-recovery::backdrop{background:rgba(0,0,0,.4)}';
      document.head.appendChild(style);
    }
    var previous = document.activeElement;
    var dialog = document.createElement('dialog');
    dialog.className = 'account-recovery settings-panel';
    dialog.setAttribute('aria-labelledby', 'account-recovery-title');
    dialog.style.cssText = 'box-sizing:border-box;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid #666;border-radius:8px;background:var(--bg-panel,#252527);color:var(--text-primary,#f4f4f4);';
    dialog.innerHTML = '<form><h2 id="account-recovery-title" style="font-size:20px;margin:0 0 18px">找回密码</h2>' +
      '<label class="settings-field">注册邮箱<input name="email" type="email" autocomplete="email" required maxlength="254" style="width:100%;box-sizing:border-box;margin:8px 0 16px"></label>' +
      '<div data-recovery-details hidden><label class="settings-field">邮箱验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" style="width:100%;box-sizing:border-box;margin:8px 0 16px"></label>' +
      '<label class="settings-field">新密码<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="至少 8 位" style="width:100%;box-sizing:border-box;margin:8px 0 16px"></label>' +
      '<label class="settings-field">确认新密码<input name="confirmation" type="password" autocomplete="new-password" style="width:100%;box-sizing:border-box;margin:8px 0 16px"></label></div>' +
      '<p data-recovery-status role="status" style="line-height:1.6;overflow-wrap:anywhere">密码重设后，所有设备及课程网站、后台都需要重新登录。</p>' +
      '<div class="settings-actions" style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="settings-btn" data-recovery-submit>发送验证码</button><button type="button" class="settings-btn" data-recovery-resend hidden>重新发送</button><button type="button" class="settings-btn" data-recovery-close>取消</button></div></form>';
    document.body.appendChild(dialog);
    active = dialog;
    var form = dialog.querySelector('form'), email = form.elements.email, status = dialog.querySelector('[data-recovery-status]');
    var submit = dialog.querySelector('[data-recovery-submit]'), resend = dialog.querySelector('[data-recovery-resend]');
    var requested = false, busy = false, timer = null, cooldown = 0;
    email.value = String(options.email || '');
    function close() { clearInterval(timer); dialog.close(); dialog.remove(); active = null; if (previous && previous.isConnected) previous.focus(); if (typeof options.onClose === 'function') options.onClose(); }
    function startCooldown() { cooldown = 60; resend.disabled = true; resend.textContent = '60 秒后重发'; clearInterval(timer); timer = setInterval(function () { cooldown -= 1; resend.textContent = cooldown > 0 ? cooldown + ' 秒后重发' : '重新发送'; if (!cooldown) { clearInterval(timer); resend.disabled = busy; } }, 1000); }
    async function sendCode() {
      var result = await root.V7Backend.requestPasswordRecovery(email.value);
      requested = true;
      email.readOnly = true;
      dialog.querySelector('[data-recovery-details]').hidden = false;
      ['code', 'password', 'confirmation'].forEach(function (name) { form.elements[name].required = true; });
      submit.textContent = '重设密码'; resend.hidden = false;
      status.textContent = result.delivery === 'development' ? '开发测试验证码：' + result.devCode + '（未发送真实邮件）' : result.message;
      startCooldown(); form.elements.code.focus();
    }
    async function run(action) { if (busy) return; busy = true; submit.disabled = true; resend.disabled = true; try { await action(); } catch (error) { status.textContent = error.message || '操作未完成，请稍后重试。'; } finally { busy = false; submit.disabled = false; resend.disabled = cooldown > 0; } }
    form.onsubmit = function (event) { event.preventDefault(); run(async function () {
      if (!requested) { await sendCode(); return; }
      if (form.elements.password.value !== form.elements.confirmation.value) { status.textContent = '两次输入的新密码不一致。'; form.elements.confirmation.focus(); return; }
      var result = await root.V7Backend.resetPassword(email.value, form.elements.code.value, form.elements.password.value);
      status.textContent = result.message;
      form.elements.password.value = ''; form.elements.confirmation.value = ''; form.elements.code.value = '';
      dialog.querySelector('[data-recovery-details]').hidden = true; submit.hidden = true; resend.hidden = true;
      clearInterval(timer); dialog.querySelector('[data-recovery-close]').textContent = '返回登录';
    }); };
    resend.onclick = function () { run(sendCode); };
    dialog.querySelector('[data-recovery-close]').onclick = close;
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.showModal(); email.focus();
  }
  root.V7AccountRecovery = { open: open };
})(window);
