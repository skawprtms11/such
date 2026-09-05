/**
 * 계정 (모바일 앱).
 *
 *   #/account   이름 · 역할 · 소속 · 로그아웃 · `웹 화면으로`
 *
 * 🔑 `웹 화면으로` 는 태블릿·PC 로 앱 셸에 들어온 사용자의 탈출구다.
 * localStorage 의 tpl_force_shell 에 'web' 을 심으면 로그인 화면의 기기 분기가
 * 이후로 웹 셸을 고르게 된다 (설계서 §1-3).
 */
import { signOut, roleLabel } from '../../auth.js';
import { icon } from '../../icons.js';
import { esc, confirmDialog } from '../../util.js';
import { forceShell, WEB_SHELL } from '../../shell.js';

export async function render(root, { user }) {
    root.innerHTML = `
<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">이름</span>
    <span class="m-kv__v"><b>${esc(user.name)}</b></span></div>
  <div class="m-kv__row"><span class="m-kv__k">소속</span>
    <span class="m-kv__v">${esc(user.company)}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">권한</span>
    <span class="m-kv__v">${esc(roleLabel(user.role))}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">이메일</span>
    <span class="m-kv__v">${esc(user.email ?? '-')}</span></div>
</div>

<p class="m-listtitle">화면</p>
<button class="m-btn m-btn--block" type="button" id="btn-web">
  ${icon('status', 'm-icon')}<span>웹 화면으로</span></button>
<p class="m-note">표가 넓은 웹 화면으로 이동합니다. 다시 앱으로 돌아오려면
  주소 끝에 <b>?shell=app</b> 을 붙여 접속하세요.</p>

<p class="m-listtitle">계정</p>
<button class="m-btn m-btn--danger m-btn--block" type="button" id="btn-out">
  ${icon('logout', 'm-icon')}<span>로그아웃</span></button>`;

    root.querySelector('#btn-web').addEventListener('click', async () => {
        if (!await confirmDialog('웹 화면으로 이동하시겠습니까?')) return;
        forceShell('web');
        location.href = WEB_SHELL;
    });

    root.querySelector('#btn-out').addEventListener('click', async () => {
        if (!await confirmDialog('로그아웃 하시겠습니까?')) return;
        await signOut();
        location.replace('index.html');
    });

    return null;
}
