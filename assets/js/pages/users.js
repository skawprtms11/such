/** 사용자관리 화면 - 관리자만 접근하며 권한 변경과 계정 사용여부를 관리한다 */
import { ROLE, ROLE_LABEL, COMPANY, COMPANIES } from '../config.js';
import { roleLabel } from '../auth.js';
import * as db from '../db.js';
import { esc, num, today, downloadCsv, toast, openModal, confirmDialog } from '../util.js';

export async function render(root) {
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
        drawTable(root, rows, reload);
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

function drawTable(root, rows, reload) {
    const tbl = root.querySelector('#tbl');
    tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>이름</th><th>이메일</th><th>소속</th><th>연락처</th>
  <th>권한</th><th class="center">사용여부</th>
</tr></thead>
<tbody>
${rows.map((u, i) => `
<tr>
  <td class="num">${i + 1}</td>
  <td><strong>${esc(u.name)}</strong></td>
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
    <button class="btn btn--sm ${u.active ? '' : 'btn--danger'}" data-active="${u.id}"
            type="button">${u.active ? '사용' : '중지'}</button>
  </td>
</tr>`).join('')}
</tbody>`;

    tbl.querySelectorAll('[data-company]').forEach((el) => {
        el.addEventListener('change', async () => {
            try {
                await db.updateUserCompany(el.dataset.company, el.value);
                toast('소속이 변경되었습니다.', 'success');
                reload();
            } catch (err) {
                toast(err.message, 'error');
                reload();
            }
        });
    });

    tbl.querySelectorAll('[data-role]').forEach((el) => {
        el.addEventListener('change', async () => {
            try {
                await db.updateUserRole(el.dataset.role, el.value);
                toast('권한이 변경되었습니다.', 'success');
                reload();
            } catch (err) {
                toast(err.message, 'error');
                reload();
            }
        });
    });

    tbl.querySelectorAll('[data-active]').forEach((el) => {
        el.addEventListener('click', async () => {
            if (!await confirmDialog('사용여부를 변경하시겠습니까?')) return;
            try {
                await db.toggleUserActive(el.dataset.active);
                reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 사용자 추가 폼 */
function openForm(reload) {
    const m = openModal('사용자 추가', `
<form id="user-form">
  <div class="form-grid">
    <label class="field">
      <span class="field__label">이름 *</span>
      <input type="text" name="name" required>
    </label>
    <label class="field">
      <span class="field__label">이메일 *</span>
      <input type="email" name="email" required>
    </label>
    <label class="field">
      <span class="field__label">소속 *</span>
      <select name="company" required>
        ${COMPANIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
      </select>
    </label>
    <label class="field">
      <span class="field__label">연락처</span>
      <input type="text" name="phone" placeholder="010-0000-0000">
    </label>
    <label class="field full">
      <span class="field__label">권한 *</span>
      <select name="role" required>
        ${Object.values(ROLE).map((r) => `
        <option value="${r}">${ROLE_LABEL[r]}</option>`).join('')}
      </select>
    </label>
  </div>
  <div class="form-actions">
    <button class="btn" type="button" id="btn-cancel">취소</button>
    <button class="btn btn--primary" type="submit">추가</button>
  </div>
</form>`);

    m.body.querySelector('#btn-cancel').addEventListener('click', m.close);
    m.body.querySelector('#user-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        // Supabase 모드에서는 로그인 계정이 함께 필요해 여기서 만들 수 없다.
        // 실패 사유를 반드시 화면에 알린다 (모달은 열어둔 채로 둔다)
        try {
            await db.createUser(Object.fromEntries(new FormData(e.target)));
            m.close();
            toast('사용자가 추가되었습니다.', 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}
