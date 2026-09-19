/**
 * 유통가공 - 작업 등록·수정 팝업 (docs/processing.md §9 · §10 · §11).
 *
 * 기본정보(제품코드·작업수량·일정) + 구성품 표 + LOT 행 편집이 한 화면에 있다.
 *
 * 🔑 **LOT 입력 중에는 표를 통째로 다시 그리지 않는다.** 입력칸의 `input` 이벤트는 모델만
 * 고치고 오류 표시만 갱신한다(`syncErrors`). 행 추가·삭제처럼 구조가 바뀔 때만 다시 그린다.
 * 실시간 갱신(폴링·Realtime)도 팝업이 열려 있으면 셸의 `guarded()` 가 막는다.
 *
 * 🔑 **화면에서 잠근 조건은 `db.js` 에도 있다** - LOT 합계 = 필요수량 · 문서 생성 후 수량·구성품
 * 수정 금지 · 마스터 없는 제품코드 거부. 화면만 믿으면 db 를 직접 불러 뚫린다.
 */
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { PROCESS_ITEM_KIND } from '../../config.js';
import {
    expandMasterItems, needQty, normalizeLots, validateLots,
} from '../../processing-calc.js';
import { confirmDialog, esc, num, openModal, toast, today } from '../../util.js';
import { groupLines, iconBtn, kindTag } from './common.js';
import { openMasterForm } from './master.js';

/** 제품 줄인가 (부자재는 LOT 을 나누지 않는다) */
function isProduct(line) {
    return line.kind === PROCESS_ITEM_KIND.PRODUCT;
}

/**
 * 줄 하나의 LOT 행 초기값.
 * 부자재는 언제나 **필요수량 한 행**이다 - `db.js` 의 `buildJobItems` 가 저장할 때 쓰는 규칙과
 * 같게 두어야 화면에서 통과한 값이 저장에서 거부되지 않는다.
 */
function initialRows(line, saved) {
    if (!isProduct(line) || !saved?.length) {
        return [{ lot: '', qty: line.need_qty, touched: false }];
    }
    // 저장된 값은 사용자가 정한 것이라 잔량 자동 채움이 덮어쓰지 않게 touched 로 표시한다
    return saved.map((r) => ({ lot: r.lot ?? '', qty: r.qty, touched: true }));
}

/** 마스터 구성품 → 편집용 줄 (제품 줄은 LOT 한 행으로 시작한다) */
function buildLines(masterItems, qty) {
    return expandMasterItems(masterItems, qty).map((b) => ({ ...b, rows: initialRows(b) }));
}

/**
 * 저장된 작업 구성품 → 편집용 줄 (수정 팝업의 초기값).
 *
 * 🔑 구분·코드·품명·필요수량은 **현재 마스터**를 따르고, 저장값에서는 LOT 행만 가져온다.
 * 저장할 때 `db.updateProcessJob` 이 마스터를 다시 읽어 검증하므로(스냅샷을 믿지 않는다),
 * 화면만 스냅샷을 보여주면 마스터가 바뀐 뒤 **화면은 통과인데 저장이 거부되는** 상태가 된다.
 * 마스터가 지워졌으면 보여줄 기준이 스냅샷뿐이라 그것으로 펼친다.
 */
function linesFromItems(items, qty, masterItems) {
    const saved = groupLines(items);
    const base = masterItems?.length
        ? expandMasterItems(masterItems, qty)
        : saved.map((l) => ({
            line_no: l.line_no,
            kind: l.kind,
            code: l.code,
            name: l.name,
            qty_per: l.qty_per,
            need_qty: needQty(l.qty_per, qty),
        }));
    const byLine = new Map(saved.map((l) => [l.line_no, l]));
    return base.map((b) => {
        const prev = byLine.get(b.line_no);
        // 마스터가 수정돼 그 자리의 품목이 바뀌었으면 옛 LOT 을 붙이지 않는다 (남의 줄에 붙는다)
        const same = prev && prev.kind === b.kind && prev.code === b.code && prev.name === b.name;
        return { ...b, rows: initialRows(b, same ? prev.rows : null) };
    });
}

/**
 * 작업 등록·수정 팝업.
 * @param {{job:object, items:Array}|null} found 있으면 수정
 * @param {Function} onSaved 저장 후 호출
 */
export async function openJobForm(found, user, onSaved) {
    const job = found?.job ?? null;
    const edit = Boolean(job);
    const canManage = can(user, 'manageProcessing');
    // 🔑 문서번호가 나간 뒤에는 인쇄된 작업지시서와 달라지므로 일정만 고칠 수 있다
    const locked = Boolean(job?.doc_no);
    const masters = await db.listProcessMasters();

    const form = {
        product_code: job?.product_code ?? '',
        qty: job?.qty ?? 1,
        start_date: job?.start_date ?? today(),
        due_date: job?.due_date ?? today(),
        master: null,
        lines: [],
    };
    if (edit) {
        form.master = await db.findProcessMasterByCode(form.product_code);
        form.lines = linesFromItems(found.items, form.qty, form.master?.items);
    }

    const title = edit ? '유통가공 작업 수정' : '유통가공 작업 등록';
    const ro = (cond) => (cond ? 'readonly' : '');
    const m = openModal(title, `
<form id="pj-form" autocomplete="off">
  <div class="pc-form-grid">
    <label class="field">
      <span class="field__label">제품코드<span class="req">*</span></span>
      <input type="text" name="product_code" list="pj-codes" required maxlength="60"
             value="${esc(form.product_code)}" ${ro(locked)}>
    </label>
    <label class="field">
      <span class="field__label">제품명</span>
      <input type="text" id="pj-name" value="${esc(job?.product_name ?? '')}" readonly>
    </label>
    <label class="field">
      <span class="field__label">작업구분</span>
      <input type="text" id="pj-wtype" value="${esc(job?.work_type ?? '')}" readonly>
    </label>
    <label class="field">
      <span class="field__label">작업수량<span class="req">*</span></span>
      <input type="number" name="qty" min="1" step="1" required
             value="${esc(form.qty)}" ${ro(locked)}>
    </label>
    <label class="field">
      <span class="field__label">시작예정일<span class="req">*</span></span>
      <input type="date" name="start_date" required value="${esc(form.start_date)}">
    </label>
    <label class="field">
      <span class="field__label">완료요청일<span class="req">*</span></span>
      <input type="date" name="due_date" required value="${esc(form.due_date)}">
    </label>
  </div>
  <datalist id="pj-codes">
    ${masters.map((x) => `<option value="${esc(x.product_code)}"
      >${esc(x.product_name)}</option>`).join('')}
  </datalist>
  ${locked ? `<p class="form-note is-warn">작업지시서(${esc(job.doc_no)})가 이미 나갔습니다.
    일정만 수정할 수 있고, 수량·구성품을 바꾸려면 삭제 후 다시 등록해야 합니다.</p>` : ''}
</form>
<div class="pc-sec">
  <div class="pc-sec__head">
    <h4>구성품</h4>
    <span class="pc-hint">제품 줄은 LOT 을 나눠 적을 수 있다. 수량 합계가 필요수량과 같아야 한다.</span>
  </div>
  <div id="pj-items"></div>
</div>`, {
        wide: true,
        footer: canManage ? `
<span class="toolbar__spacer"></span>
<button class="btn" id="pj-cancel" type="button">취소</button>
<button class="btn btn--primary" type="submit" form="pj-form">저장</button>`
            : '<span class="toolbar__spacer"></span>'
                + '<button class="btn" id="pj-cancel" type="button">닫기</button>',
    });

    const host = m.body.querySelector('#pj-items');
    const codeInput = m.body.querySelector('[name=product_code]');
    const qtyInput = m.body.querySelector('[name=qty]');

    if (!canManage) {
        m.body.querySelectorAll('input').forEach((el) => { el.readOnly = true; });
    }

    /** 이미 입력한 LOT 이 있는가 (표를 다시 그리기 전 확인 문구를 띄울지 판단한다) */
    function hasLotInput() {
        return form.lines.some((l) => l.rows.length > 1 || l.rows.some((r) => r.lot.trim()));
    }

    /** 줄 하나의 검증 결과 (부자재는 수량이 고정이라 항상 통과다) */
    function checkLine(line) {
        return validateLots(line.rows, line.need_qty);
    }

    /** 구성품 표 - 첫 행에만 구분·코드·품명·필요수량을 적고 추가된 LOT 행은 비운다 */
    function itemsHtml() {
        if (!form.lines.length) {
            return '<div class="empty">제품코드를 입력하면 구성품이 표시됩니다.</div>';
        }
        const editable = canManage && !locked;
        return `
<div class="table-wrap"><table class="grid pc-items" id="pj-item-tbl">
  <colgroup>
    <col style="width:86px"><col style="width:140px"><col>
    <col style="width:100px"><col style="width:150px"><col style="width:110px">
    <col style="width:96px">
  </colgroup>
  <thead><tr>
    <th>구분</th><th>제품코드</th><th>품명</th><th class="num">필요수량</th>
    <th>LOT</th><th class="num">수량</th><th></th>
  </tr></thead>
  <tbody>
  ${form.lines.map((line, li) => {
        const v = checkLine(line);
        const rows = line.rows.map((r, ri) => {
            const head = ri === 0;
            const mine = v.errors.filter((e) => e.index === ri);
            const badOn = (field) => (mine.some((e) => e.field === field) ? 'is-error' : '');
            return `
  <tr data-line="${li}" data-row="${ri}">
    <td>${head ? kindTag(line.kind) : ''}</td>
    <td>${head ? esc(line.code) : ''}</td>
    <td class="wrap">${head ? esc(line.name) : ''}</td>
    <td class="num">${head ? num(line.need_qty) : ''}</td>
    <td>${isProduct(line) && editable
        ? `<input type="text" data-lot class="${badOn('lot')}"
             value="${esc(r.lot)}" maxlength="40" placeholder="LOT">`
        : (isProduct(line) ? esc(r.lot || '-') : '—')}</td>
    <td class="num">${isProduct(line) && editable
        ? `<input type="number" data-qty class="${badOn('qty')}"
             min="1" step="1" value="${esc(r.qty)}">`
        : num(r.qty)}
      <span class="pc-err" data-rowmsg>${esc(mine[0]?.msg ?? '')}</span></td>
    <td class="center">${editable && isProduct(line) ? `
      ${head ? iconBtn('plus', 'LOT 행 추가', `data-add="${li}"`) : ''}
      ${line.rows.length > 1
        ? iconBtn('trash', 'LOT 행 삭제', `data-del="${li}" data-at="${ri}"`) : ''}` : ''}</td>
  </tr>`;
        }).join('');
        return `${rows}
  <tr class="pc-sum" data-sum="${li}">
    <td colspan="4"></td>
    <td colspan="3" class="num">
      합계 <b data-total>${num(v.total)}</b> / ${num(line.need_qty)}
      <span class="pc-err" data-msg>${esc(v.sumMsg)}</span>
    </td>
  </tr>`;
    }).join('')}
  </tbody>
</table></div>`;
    }

    /**
     * 오류 표시만 갱신한다 🔑 (**다시 그리지 않는다** - 입력 중에 표를 새로 만들면
     * 커서와 입력값이 통째로 날아간다)
     */
    function syncErrors() {
        const tbl = host.querySelector('#pj-item-tbl');
        if (!tbl) return;
        form.lines.forEach((line, li) => {
            const v = checkLine(line);
            line.rows.forEach((_, ri) => {
                const tr = tbl.querySelector(`tr[data-line="${li}"][data-row="${ri}"]`);
                if (!tr) return;
                const mine = v.errors.filter((e) => e.index === ri);
                ['lot', 'qty'].forEach((field) => {
                    tr.querySelector(`[data-${field}]`)
                        ?.classList.toggle('is-error', mine.some((e) => e.field === field));
                });
                tr.querySelector('[data-rowmsg]').textContent = mine[0]?.msg ?? '';
            });
            const sum = tbl.querySelector(`tr[data-sum="${li}"]`);
            if (!sum) return;
            sum.querySelector('[data-total]').textContent = num(v.total);
            sum.querySelector('[data-msg]').textContent = v.sumMsg;
        });
    }

    /** 표를 다시 그리고 이벤트를 붙인다 (행 추가·삭제·구성품 교체 때만 부른다) */
    function drawItems() {
        host.innerHTML = itemsHtml();

        host.querySelectorAll('[data-lot]').forEach((el) => {
            el.addEventListener('input', () => {
                const tr = el.closest('tr');
                form.lines[tr.dataset.line].rows[tr.dataset.row].lot = el.value;
                syncErrors();
            });
        });
        host.querySelectorAll('[data-qty]').forEach((el) => {
            el.addEventListener('input', () => {
                const tr = el.closest('tr');
                const line = form.lines[tr.dataset.line];
                const at = Number(tr.dataset.row);
                line.rows[at].qty = el.value === '' ? '' : Number(el.value);
                // 마지막 행을 직접 고쳤으면 그때부터 잔량을 자동으로 덮어쓰지 않는다
                if (at === line.rows.length - 1) {
                    line.rows[at].touched = true;
                } else {
                    line.rows = normalizeLots(line.rows, line.need_qty);
                    const last = host.querySelector(
                        `tr[data-line="${tr.dataset.line}"][data-row="${line.rows.length - 1}"] [data-qty]`);
                    if (last) last.value = line.rows[line.rows.length - 1].qty;
                }
                syncErrors();
            });
        });
        host.querySelectorAll('[data-add]').forEach((el) => {
            el.addEventListener('click', () => {
                const line = form.lines[el.dataset.add];
                line.rows.push({ lot: '', qty: 0, touched: false });
                line.rows = normalizeLots(line.rows, line.need_qty);
                drawItems();
            });
        });
        host.querySelectorAll('[data-del]').forEach((el) => {
            el.addEventListener('click', () => {
                const line = form.lines[el.dataset.del];
                line.rows.splice(Number(el.dataset.at), 1);
                // 삭제 후에는 잔량을 다시 채운다 (마지막 행의 직접 입력 표시를 지운다)
                line.rows[line.rows.length - 1].touched = false;
                line.rows = normalizeLots(line.rows, line.need_qty);
                drawItems();
            });
        });
    }

    /** 마스터를 찾지 못했을 때 - 막다른 길이 되지 않게 등록 버튼을 띄운다 (A7) */
    function drawNoMaster(code) {
        form.lines = [];
        host.innerHTML = `
<div class="pc-nomaster">
  <p>작업마스터에 없는 제품코드입니다: <b>${esc(code)}</b></p>
  ${canManage ? '<button class="btn btn--primary btn--sm" id="pj-new-master"'
        + ' type="button">작업마스터 등록</button>' : ''}
</div>`;
        host.querySelector('#pj-new-master')?.addEventListener('click', () => {
            openMasterForm(null, user, async (savedCode) => {
                if (savedCode) codeInput.value = savedCode;
                await resolveMaster(true);
            });
        });
    }

    /**
     * 제품코드·작업수량으로 구성품 표를 다시 펼친다.
     * 이미 입력한 LOT 이 있으면 확인을 받는다 (초기화되기 때문이다).
     * @param {boolean} force 확인 없이 다시 펼친다 (마스터를 방금 만들었을 때)
     */
    async function resolveMaster(force = false) {
        const code = codeInput.value.trim();
        const qty = Number(qtyInput.value);
        m.body.querySelector('#pj-name').value = '';
        m.body.querySelector('#pj-wtype').value = '';
        if (!code) {
            form.lines = [];
            drawItems();
            return;
        }
        const found2 = await db.findProcessMasterByCode(code);
        if (!found2) {
            drawNoMaster(code);
            return;
        }
        m.body.querySelector('#pj-name').value = found2.master.product_name;
        m.body.querySelector('#pj-wtype').value = found2.master.work_type;

        const sameMaster = form.master?.master?.id === found2.master.id;
        if (sameMaster && qty === form.qty && form.lines.length) return;
        if (!force && form.lines.length && hasLotInput()
            && !(await confirmDialog('입력한 LOT 이 초기화됩니다. 계속할까요?'))) {
            // 되돌린다 - 사용자가 취소했으므로 화면 값도 원래대로 맞춘다
            codeInput.value = form.product_code;
            qtyInput.value = form.qty;
            m.body.querySelector('#pj-name').value = form.master?.master?.product_name ?? '';
            m.body.querySelector('#pj-wtype').value = form.master?.master?.work_type ?? '';
            return;
        }
        form.master = found2;
        form.product_code = found2.master.product_code;
        form.qty = Number.isInteger(qty) && qty > 0 ? qty : 1;
        form.lines = buildLines(found2.items, form.qty);
        drawItems();
    }

    if (canManage && !locked) {
        codeInput.addEventListener('change', () => resolveMaster());
        qtyInput.addEventListener('change', () => resolveMaster());
    }
    drawItems();

    m.root.querySelector('#pj-cancel').addEventListener('click', () => m.close());
    m.body.querySelector('#pj-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const payload = {
            product_code: String(f.get('product_code') ?? '').trim(),
            qty: Number(f.get('qty')),
            start_date: f.get('start_date'),
            due_date: f.get('due_date'),
        };
        if (!locked) {
            const bad = form.lines.find((line) => !checkLine(line).ok);
            if (!form.lines.length) {
                toast('작업마스터에 있는 제품코드를 입력하세요.', 'error');
                return;
            }
            if (bad) {
                const v = checkLine(bad);
                toast(`구성품 '${bad.name}' - ${v.errors[0]?.msg ?? `합계가 ${v.sumMsg} 입니다.`}`,
                    'error');
                return;
            }
            payload.items = form.lines.flatMap((line) => line.rows.map((r) => ({
                line_no: line.line_no,
                lot: r.lot,
                qty: Number(r.qty),
            })));
        }
        try {
            if (edit) await db.updateProcessJob(job.id, payload, user);
            else await db.createProcessJob(payload, user);
            m.close();
            toast(edit ? '작업을 수정했습니다.' : '작업을 등록했습니다.', 'success');
            await onSaved?.();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    return m;
}
