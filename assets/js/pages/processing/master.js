/**
 * 유통가공 - 작업마스터 탭 (docs/processing.md §13).
 *
 * 제품 1건의 구성품(BOM)을 등록해 둔다. 작업 등록 폼은 **제품코드만으로** 이 마스터를 찾아
 * 구성품을 펼치므로, 살아 있는 마스터는 제품코드당 1건이다.
 *
 * 등록·수정 폼은 작업 등록 폼(jobform.js)도 부른다 - 마스터에 없는 제품코드를 쳤을 때
 * 막다른 길이 되지 않도록 그 자리에서 마스터를 만들 수 있게 한다 (A7).
 */
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { PROCESS_ITEM_KIND, PROCESS_ITEM_KINDS, PROCESS_WORK_TYPES } from '../../config.js';
import { confirmDialog, esc, num, openModal, toast } from '../../util.js';
import { emptyRow, iconBtn, openSafe, workTypeOptions } from './common.js';

/** 작업마스터 탭을 그린다 */
export async function drawMaster({ state, body, user, reload }) {
    const canManage = can(user, 'manageProcessing');
    const rows = await db.listProcessMasters({
        keyword: state.masterKeyword,
        workType: state.masterWorkType,
    });

    body.innerHTML = `
<div class="toolbar">
  <label class="field" style="flex:0 0 140px">
    <span class="field__label">작업구분</span>
    <select id="pm-f-type">${workTypeOptions(state.masterWorkType)}</select>
  </label>
  <label class="field" style="flex:1 1 160px;max-width:260px">
    <span class="field__label">제품코드 / 제품명</span>
    <input type="text" id="pm-f-kw" placeholder="검색어 입력" value="${esc(state.masterKeyword)}">
  </label>
  <button class="btn" id="pm-search" type="button">조회</button>
  <span class="toolbar__spacer"></span>
  ${canManage
        ? '<button class="btn btn--primary" id="pm-new" type="button">마스터 등록</button>'
        : ''}
</div>
<div class="table-wrap"><table class="grid" id="pm-tbl">
  <colgroup>
    <col style="width:56px"><col style="width:90px"><col style="width:160px"><col>
    <col style="width:90px"><col style="width:110px"><col style="width:110px">
  </colgroup>
  <thead><tr>
    <th>연번</th><th>작업구분</th><th>제품코드</th><th>제품명</th>
    <th class="center">구성품</th><th>등록자</th><th>등록일</th>
  </tr></thead>
  <tbody>
    ${rows.length ? rows.map((m, i) => `
    <tr class="is-clickable" data-id="${esc(m.id)}">
      <td class="center">${num(i + 1)}</td>
      <td>${esc(m.work_type)}</td>
      <td>${esc(m.product_code)}</td>
      <td class="wrap"><span class="link">${esc(m.product_name)}</span></td>
      <td class="center">${num(m.item_count)}</td>
      <td>${esc(m.created_by_name)}</td>
      <td>${esc(String(m.created_at).slice(0, 10))}</td>
    </tr>`).join('') : emptyRow(7, '등록된 작업마스터가 없습니다.')}
  </tbody>
</table></div>`;

    body.querySelector('#pm-search').addEventListener('click', () => {
        state.masterKeyword = body.querySelector('#pm-f-kw').value.trim();
        state.masterWorkType = body.querySelector('#pm-f-type').value;
        reload();
    });
    body.querySelector('#pm-f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') body.querySelector('#pm-search').click();
    });
    body.querySelector('#pm-new')?.addEventListener('click', () => {
        openMasterForm(null, user, reload);
    });
    body.querySelectorAll('#pm-tbl tbody tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', () => {
            openSafe(db.getProcessMaster(tr.dataset.id)
                .then((found) => (found ? openMasterForm(found, user, reload)
                    : toast('작업마스터를 찾을 수 없습니다.', 'error'))));
        });
    });
}

/** 구성품 표의 한 행 (등록·수정 폼 안) */
function itemRowHtml(it = {}) {
    return `
<tr>
  <td>
    <select data-kind>
      ${PROCESS_ITEM_KINDS.map((k) => `<option value="${esc(k)}"
        ${k === it.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}
    </select>
  </td>
  <td><input type="text" data-code value="${esc(it.code ?? '')}" placeholder="제품은 필수"></td>
  <td><input type="text" data-name value="${esc(it.name ?? '')}"></td>
  <td><input type="number" min="1" step="1" data-qty value="${esc(it.qty_per ?? 1)}"></td>
  <td class="center">${iconBtn('trash', '구성품 삭제', 'data-del', 'btn btn--icon btn--sm')}</td>
</tr>`;
}

/**
 * 마스터 등록·수정 팝업.
 * 🔑 권한이 없으면 **저장·삭제 버튼이 아예 렌더되지 않고** 입력칸도 잠긴다.
 * (db.js 의 쓰기 함수도 같은 조건으로 거부한다 - 화면 잠금만 두면 db 를 직접 불러 뚫린다)
 * @param {{master:object, items:Array}|null} found 있으면 수정
 * @param {Function} onSaved 저장 후 호출 (목록 새로고침 · 작업 폼의 구성품 다시 펼치기)
 */
export function openMasterForm(found, user, onSaved) {
    const master = found?.master ?? null;
    const items = found?.items ?? [];
    const edit = Boolean(master);
    const canManage = can(user, 'manageProcessing');
    const title = canManage ? (edit ? '작업마스터 수정' : '작업마스터 등록') : '작업마스터';

    const m = openModal(title, `
<form id="pm-form">
  <div class="pc-form-grid">
    <label class="field">
      <span class="field__label">작업구분<span class="req">*</span></span>
      <select name="work_type">
        ${PROCESS_WORK_TYPES.map((t) => `<option value="${esc(t)}"
          ${t === master?.work_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
    </label>
    <label class="field">
      <span class="field__label">제품코드<span class="req">*</span></span>
      <input type="text" name="product_code" required maxlength="60"
             value="${esc(master?.product_code ?? '')}">
    </label>
    <label class="field">
      <span class="field__label">제품명<span class="req">*</span></span>
      <input type="text" name="product_name" required maxlength="120"
             value="${esc(master?.product_name ?? '')}">
    </label>
  </div>
</form>
<div class="pc-sec">
  <div class="pc-sec__head">
    <h4>구성품</h4>
    <span class="pc-hint">작업 1개당 필요한 수량을 적는다. 제품이 1건 이상 있어야 한다.</span>
    <span class="toolbar__spacer"></span>
    ${canManage
        ? '<button class="btn btn--sm" id="pm-add" type="button">+ 구성품 추가</button>' : ''}
  </div>
  <div class="table-wrap"><table class="grid pc-items" id="pm-items">
    <colgroup>
      <col style="width:110px"><col style="width:160px"><col>
      <col style="width:110px"><col style="width:56px">
    </colgroup>
    <thead><tr>
      <th>구분</th><th>코드</th><th>품목명</th><th>필요수량</th><th></th>
    </tr></thead>
    <tbody>${(items.length ? items : [{ kind: PROCESS_ITEM_KIND.PRODUCT, qty_per: 1 }])
        .map((it) => itemRowHtml(it)).join('')}</tbody>
  </table></div>
</div>`, {
        wide: true,
        footer: canManage ? `
${edit ? '<button class="btn btn--danger" id="pm-del" type="button">삭제</button>' : ''}
<span class="toolbar__spacer"></span>
<button class="btn" id="pm-cancel" type="button">취소</button>
<button class="btn btn--primary" type="submit" form="pm-form">저장</button>`
            : '<span class="toolbar__spacer"></span>'
                + '<button class="btn" id="pm-cancel" type="button">닫기</button>',
    });

    const tbody = m.body.querySelector('#pm-items tbody');

    if (canManage) {
        // 행이 늘어도 다시 붙일 필요가 없도록 tbody 한 곳에서 위임으로 받는다
        tbody.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-del]');
            if (!btn) return;
            // 마지막 한 줄은 남긴다 (구성품 0건은 저장할 수 없다)
            if (tbody.rows.length <= 1) {
                toast('구성품은 1건 이상 있어야 합니다.', 'error');
                return;
            }
            btn.closest('tr').remove();
        });
        m.body.querySelector('#pm-add').addEventListener('click', () => {
            tbody.insertAdjacentHTML('beforeend',
                itemRowHtml({ kind: PROCESS_ITEM_KIND.MATERIAL, qty_per: 1 }));
        });
    } else {
        m.body.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
        m.body.querySelectorAll('[data-del]').forEach((el) => el.remove());
    }

    m.root.querySelector('#pm-cancel').addEventListener('click', () => m.close());
    m.root.querySelector('#pm-del')?.addEventListener('click', async () => {
        if (!(await confirmDialog(
            `작업마스터 '${master.product_code}' 를 삭제할까요?`
            + '\n이미 등록된 작업의 구성품은 복사되어 있어 영향받지 않습니다.'))) return;
        try {
            await db.deleteProcessMaster(master.id, user);
            m.close();
            toast('작업마스터를 삭제했습니다.', 'success');
            await onSaved?.();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    m.body.querySelector('#pm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const payload = {
            work_type: f.get('work_type'),
            product_code: String(f.get('product_code') ?? '').trim(),
            product_name: String(f.get('product_name') ?? '').trim(),
            items: [...tbody.rows].map((tr) => ({
                kind: tr.querySelector('[data-kind]').value,
                code: tr.querySelector('[data-code]').value.trim(),
                name: tr.querySelector('[data-name]').value.trim(),
                qty_per: Number(tr.querySelector('[data-qty]').value),
            })),
        };
        try {
            if (edit) await db.updateProcessMaster(master.id, payload, user);
            else await db.createProcessMaster(payload, user);
            m.close();
            toast(edit ? '작업마스터를 수정했습니다.' : '작업마스터를 등록했습니다.', 'success');
            await onSaved?.(payload.product_code);
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    return m;
}
