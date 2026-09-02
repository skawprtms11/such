/** 사용자관리 화면 - 관리자만 접근하며 권한 변경과 계정 사용여부를 관리한다 */
import { ROLE, ROLE_LABEL, COMPANY, COMPANIES, INITIAL_PASSWORD } from '../config.js';
import { roleLabel } from '../auth.js';
import * as db from '../db.js';
import { esc, num, today, downloadCsv, toast, openModal, confirmDialog } from '../util.js';

export async function render(root, { user: me }) {
    root.innerHTML = `
<div id="summary" class="summary"></div>

<div class="card">
  <div class="card__head">
    <h2>사용자 목록</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row">
      <button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>
      <button class="btn btn--primary btn--sm" id="btn-new" type="button">사용자 추가</button>
    </div>
  </div>
  <div class="card__body">
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
    <p class="field__label" style="margin-top:12px">
      권한 변경은 즉시 반영되며, 해당 사용자의 다음 화면 조회부터 적용됩니다.<br>
      주문정보등록 화면은 <b>소속</b>에 따라 동작이 달라집니다 —
      ${COMPANY.CUSTOMER}는 등록·수정·조정요청,
      ${COMPANY.LOGISTICS}는 조회와 확인처리를 할 수 있습니다.
      (관리자·화주관리자는 소속과 무관하게 모두 가능)
    </p>
  </div>
</div>`;

    let rows = [];

    async function reload() {
        rows = await db.listUsers();
        drawSummary(root, rows);
        drawTable(root, rows, reload, me);
        root.querySelector('#row-count').textContent = `${num(rows.length)}명`;
    }

    root.querySelector('#btn-csv').addEventListener('click', () => {
        downloadCsv(`사용자목록_${today()}.csv`,
            ['이름', '이메일', '소속', '연락처', '권한', '사용여부'],
            rows.map((u) => [
                u.name, u.email, u.company, u.phone ?? '',
                roleLabel(u.role), u.active ? '사용' : '중지',
            ]));
    });

    root.querySelector('#btn-new').addEventListener('click', () => openForm(reload));

    await reload();
    return db.subscribe(reload);
}

function drawSummary(root, rows) {
    const count = (r) => rows.filter((u) => u.role === r).length;
    root.querySelector('#summary').innerHTML = Object.values(ROLE).map((r, i) => `
<div class="stat ${i === 0 ? 'stat--accent' : ''}">
  <div class="stat__label">${ROLE_LABEL[r]}</div>
  <div class="stat__value">${num(count(r))}<small>명</small></div>
</div>`).join('');
}

function drawTable(root, rows, reload, me) {
    const tbl = root.querySelector('#tbl');
    tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>이름</th><th>이메일</th><th>소속</th><th>연락처</th>
  <th>권한</th><th class="center">비밀번호</th>
  <th class="center">사용여부</th><th class="center">관리</th>
</tr></thead>
<tbody>
${rows.map((u, i) => `
<tr>
  <td class="num">${i + 1}</td>
  <td><strong>${esc(u.name)}</strong>${u.id === me?.id ? ' <span class="tag tag--blue">나</span>' : ''}</td>
  <td>${esc(u.email)}</td>
  <td>
    <select data-company="${u.id}" style="min-width:118px">
      ${COMPANIES.map((c) => `
      <option value="${c}" ${u.company === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>
  </td>
  <td>${esc(u.phone ?? '')}</td>
  <td>
    <select data-role="${u.id}" style="min-width:130px">
      ${Object.values(ROLE).map((r) => `
      <option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
    </select>
  </td>
  <td class="center">
    <button class="btn btn--sm" data-pw="${u.id}" type="button">초기화</button>
  </td>
  <td class="center">
    <button class="btn btn--sm ${u.active ? '' : 'btn--danger'}" data-active="${u.id}"
            type="button">${u.active ? '사용' : '중지'}</button>
  </td>
  <td class="center">
    <div class="btn-row" style="justify-content:center;flex-wrap:nowrap">
      <button class="btn btn--sm" data-edit="${u.id}" type="button">수정</button>
      <button class="btn btn--sm btn--danger" data-del="${u.id}" type="button"
              ${u.id === me?.id ? 'disabled title="본인 계정은 삭제할 수 없습니다"' : ''}>삭제</button>
    </div>
  </td>
</tr>`).join('')}
</tbody>`;

    /** 실패하면 반드시 화면에 알린다 */
    const run = async (fn, okMsg) => {
        try {
            await fn();
            if (okMsg) toast(okMsg, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
            reload();
        }
    };

    tbl.querySelectorAll('[data-company]').forEach((el) => {
        el.addEventListener('change', () => run(
            () => db.updateUserCompany(el.dataset.company, el.value), '소속이 변경되었습니다.',
        ));
    });

    tbl.querySelectorAll('[data-role]').forEach((el) => {
        el.addEventListener('change', () => run(
            () => db.updateUserRole(el.dataset.role, el.value), '권한이 변경되었습니다.',
        ));
    });

    tbl.querySelectorAll('[data-active]').forEach((el) => {
        el.addEventListener('click', async () => {
            if (!await confirmDialog('사용여부를 변경하시겠습니까?')) return;
            run(() => db.toggleUserActive(el.dataset.active));
        });
    });

    // 비밀번호 초기화 - 초기화된 비밀번호를 관리자에게 알려준다
    tbl.querySelectorAll('[data-pw]').forEach((el) => {
        el.addEventListener('click', async () => {
            const u = rows.find((x) => x.id === el.dataset.pw);
            const ok = await confirmDialog(
                `${u.name} 님의 비밀번호를 초기화하시겠습니까?\n\n`
                + `초기화하면 비밀번호가 ${INITIAL_PASSWORD} 로 바뀝니다.`,
            );
            if (!ok) return;
            try {
                const pw = await db.resetUserPassword(u.id);
                openModal('비밀번호 초기화 완료', `
<p class="form-note" style="margin:0 0 10px">
  <b>${esc(u.name)}</b> (${esc(u.email)}) 님의 비밀번호를 초기화했습니다.
</p>
<div class="pw-box">${esc(pw)}</div>
<p class="form-note">
  이 비밀번호를 본인에게 알려주고 <b>로그인 후 바꾸도록</b> 안내하세요.
</p>`);
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });

    tbl.querySelectorAll('[data-edit]').forEach((el) => {
        el.addEventListener('click', () => {
            openForm(reload, rows.find((x) => x.id === el.dataset.edit));
        });
    });

    tbl.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', async () => {
            const u = rows.find((x) => x.id === el.dataset.del);
            const ok = await confirmDialog(
                `${u.name} (${u.email}) 님을 삭제하시겠습니까?\n\n`
                + '로그인 계정까지 함께 지워지며 되돌릴 수 없습니다.\n'
                + '잠시 막아두려면 삭제 대신 사용여부를 중지로 바꾸세요.',
            );
            if (!ok) return;
            run(() => db.deleteUser(u.id), '사용자를 삭제했습니다.');
        });
    });
}

/**
 * 사용자 등록·수정 폼.
 * @param {object} [edit] 주어지면 수정 모드로 연다
 */
function openForm(reload, edit = null) {
    const v = (k) => esc(edit?.[k] ?? '');
    const m = openModal(edit ? '사용자 정보 수정' : '사용자 추가', `
<form id="user-form">
  <div class="form-grid">
    <label class="field">
      <span class="field__label">이름 *</span>
      <input type="text" name="name" value="${v('name')}" required>
    </label>
    <label class="field">
      <span class="field__label">이메일 *</span>
      <input type="email" name="email" value="${v('email')}" required>
    </label>
    <label class="field">
      <span class="field__label">소속 *</span>
      <select name="company" required>
        ${COMPANIES.map((c) => `<option value="${c}" ${edit?.company === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </label>
    <label class="field">
      <span class="field__label">연락처</span>
      <input type="text" name="phone" value="${v('phone')}" placeholder="010-0000-0000">
    </label>
    ${edit ? '' : `
    <label class="field">
      <span class="field__label">초기 비밀번호 *</span>
      <input type="text" name="password" required value="${INITIAL_PASSWORD}"
             autocomplete="off">
    </label>`}
    <label class="field full">
      <span class="field__label">권한 *</span>
      <select name="role" required>
        ${Object.values(ROLE).map((r) => `
        <option value="${r}" ${edit?.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
      </select>
    </label>
  </div>
  <div class="form-actions">
    <button class="btn" type="button" id="btn-cancel">취소</button>
    <button class="btn btn--primary" type="submit">${edit ? '저장' : '추가'}</button>
  </div>
</form>`);

    m.body.querySelector('#btn-cancel').addEventListener('click', m.close);
    m.body.querySelector('#user-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = Object.fromEntries(new FormData(e.target));
        // 실패 사유를 반드시 화면에 알린다 (모달은 열어둔 채로 둔다)
        try {
            if (edit) {
                await db.updateUser(edit.id, form);
                m.close();
                toast('사용자 정보를 저장했습니다.', 'success');
            } else {
                // Supabase 모드에서는 로그인 계정이 함께 필요해 여기서 만들 수 없다
                await db.createUser(form);
                m.close();
                toast('사용자가 추가되었습니다.', 'success');
            }
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}
