/**
 * 체크리스트 등록 탭 🔑 - 담당자가 기준(일별·주차별·월별)마다 체크할 **독립 체크항목**을
 * 인라인 표로 등록·수정한다.
 *
 * 업무프로세스 탭의 흐름(트리)과는 상관이 없다 - 여기서 만든 항목은 `parent_id` 가 없고,
 * 일일체크리스트가 `db.checklistBoard()` 로 그대로 읽는다.
 *
 * 편집 규약은 업무프로세스 탭의 우측 설명 표(process.js)와 같다 - 마지막 줄은 늘 빈 행이고
 * 값이 들어오면 그때 등록된다. 저장은 blur(change) 이며, 실패하면 값을 그대로 두고
 * 토스트만 띄운다 (다시 그리면 사용자가 적은 것이 사라진다).
 *
 * 부담당자·활성 여부·주차별 요일 같은 잔 속성은 ✎ 속성 모달(form.js)에서 고친다.
 */
import * as db from '../../db.js';
import { BOARD_CYCLES, CHECK_CYCLE, CHECK_KIND } from '../../config.js';
import { icon } from '../../icons.js';
import { confirmDialog, esc, toast } from '../../util.js';
import { iconBtn } from './common.js';
import { openForm } from './form.js';

/** 표의 칸 순서 - Tab 이 옮겨 갈 다음 칸을 알려면 순서를 알아야 한다 */
const FIELDS = ['category', 'title', 'cycle', 'assignee_id', 'description'];

/** 그 칸의 다음 칸 (마지막 칸이면 다시 첫 칸 - 빈 행의 첫 칸으로 이어진다) */
function nextField(field) {
    return FIELDS[FIELDS.indexOf(field) + 1] ?? FIELDS[0];
}

/** 등록 기준 select - 보드가 다루는 일별·주차별·월별 3종뿐이다 (수시는 없다) */
function cycleCell(cur, ro) {
    return `<select data-rf="cycle" aria-label="주기" ${ro ? 'disabled' : ''}>
    ${Object.entries(BOARD_CYCLES).map(([k, label]) => `
    <option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(label)}</option>`).join('')}
  </select>`;
}

/** 담당자 select - 정담당자만 고른다 (부담당자는 ✎ 속성 모달) */
function whoCell(cur, users, ro) {
    return `<select data-rf="assignee_id" aria-label="담당자" ${ro ? 'disabled' : ''}>
    <option value="">공통</option>
    ${users.map((u) => `
    <option value="${esc(u.id)}" ${u.id === cur ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
  </select>`;
}

/** 줄 하나. id 가 빈 줄은 **빈 행**이다 - 항목 이름이 들어오면 그때 등록한다 */
function rowHtml(it, users, ro) {
    const id = it?.id ?? '';
    const subs = it?.sub_assignees ?? [];
    return `
<tr data-row="${esc(id)}" class="${id ? '' : 'is-draft'} ${it && it.active === false ? 'is-off' : ''}">
  <td><input type="text" list="cl-reg-cats" maxlength="40" data-rf="category"
             value="${esc(it?.category ?? '')}" placeholder="구분" aria-label="구분"
             ${ro ? 'readonly' : ''}></td>
  <td><input type="text" maxlength="80" data-rf="title" value="${esc(it?.title ?? '')}"
             placeholder="${id ? '' : '항목 이름을 적으면 줄이 생깁니다'}" aria-label="항목"
             ${ro ? 'readonly' : ''}></td>
  <td>${cycleCell(it?.cycle ?? CHECK_CYCLE.DAILY, ro)}</td>
  <td>${whoCell(it?.assignee_id ?? '', users, ro)}
    ${subs.length ? `<small class="cl-reg__sub">부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}
  </td>
  <td><textarea rows="1" maxlength="500" data-rf="description" placeholder="내용"
                aria-label="내용" ${ro ? 'readonly' : ''}
      >${esc(it?.description ?? '')}</textarea></td>
  <td class="cl-reg__tools">${id && !ro ? `
    <span class="pm-grip" title="끌어서 순서 바꾸기">${icon('menu', 'icon icon--sm')}</span>
    ${iconBtn('edit', '속성 수정 (부담당자·요일·활성)', `data-rprop="${esc(id)}"`)}
    ${iconBtn('close', '이 줄 삭제', `data-rdel="${esc(id)}"`)}` : ''}</td>
</tr>`;
}

/**
 * 등록 탭 그리기.
 * @param {{state:object, body:Element, user:object, users:Array, canManage:boolean,
 *          reload:Function}} ctx
 */
export async function drawRegister(ctx) {
    const { body, users, canManage } = ctx;
    const ro = !canManage;
    const items = (await db.listChecklistItems({
        kind: CHECK_KIND.CHECK, includeInactive: true,
    })).filter((i) => !i.parent_id && i.cycle !== CHECK_CYCLE.ADHOC);
    const cats = await db.checklistCategories();

    body.className = 'card__body';
    body.innerHTML = `
<p class="cl-scope">${icon('checklist', 'icon icon--sm')}
  등록 기준(일별·주차별·월별)에 따라 담당자의 일일체크리스트에 나옵니다.
  ${ro ? '조회만 할 수 있습니다.' : '마지막 빈 줄에 적으면 새 항목이 생깁니다.'}</p>
<table class="cl-reg">
  <thead><tr>
    <th>구분</th><th>항목</th><th>주기</th><th>담당자</th><th>내용</th><th></th>
  </tr></thead>
  <tbody>${items.map((it) => rowHtml(it, users, ro)).join('')}${ro ? '' : rowHtml(null, users, false)}</tbody>
</table>
<datalist id="cl-reg-cats">
  ${cats.map((c) => `<option value="${esc(c)}"></option>`).join('')}
</datalist>
${items.length ? '' : `
<p class="empty">등록된 체크리스트가 없습니다.${ro ? '' : ' 위 빈 줄에서 추가하세요.'}</p>`}`;

    if (!ro) bindRows(ctx, items);
}

/** 인라인 편집 - 값이 바뀌면(blur) 그때 저장한다 */
function bindRows(ctx, items) {
    const { body, user, users, reload } = ctx;
    const table = body.querySelector('.cl-reg');
    // 실시간 갱신이 입력하던 값을 지우지 않게 표시해 둔다 (checklist.js 의 guarded)
    table.addEventListener('input', (e) => {
        if (e.target.matches('input, textarea')) e.target.classList.add('is-dirty');
    });

    const valuesOf = (tr) => {
        const get = (k) => tr.querySelector(`[data-rf="${k}"]`)?.value.trim() ?? '';
        return {
            category: get('category'),
            title: get('title'),
            cycle: get('cycle') || CHECK_CYCLE.DAILY,
            assignee_id: get('assignee_id') || null,
            description: get('description'),
        };
    };
    /* Tab 으로 칸을 옮기면 change(=blur) 가 **먼저** 오므로, 저장 뒤에 어디로 갈 셈이었는지
       알 수 있게 마지막 키를 적어 둔다 (빈 행은 저장하면 표를 다시 그려야 한다) */
    let tabbed = false;
    table.addEventListener('keydown', (e) => { tabbed = e.key === 'Tab' && !e.shiftKey; });

    table.querySelectorAll('tr[data-row]').forEach((tr) => {
        const id = tr.dataset.row;
        tr.querySelectorAll('[data-rf]').forEach((el) => {
            el.addEventListener('change', async () => {
                const vals = valuesOf(tr);
                // 빈 행은 이름이 있어야 등록한다 (지나가며 고른 주기·담당자만으로는 만들지 않는다)
                if (!id && !vals.title) return;
                const field = el.dataset.rf;
                try {
                    if (id) {
                        // 🔑 표를 다시 그리지 않는다 - 그리면 Tab 으로 옮긴 포커스가 사라진다
                        await db.updateChecklistItem(id, { [field]: vals[field] }, user);
                        el.classList.remove('is-dirty');
                        return;
                    }
                    const row = await db.createChecklistItem({
                        ...vals, kind: CHECK_KIND.CHECK, parent_id: null, daily: true,
                    }, user);
                    el.classList.remove('is-dirty');
                    const want = tabbed ? nextField(field) : field;
                    await reload();
                    focusRow(body, row?.id, want);
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });
    });

    table.querySelectorAll('[data-rdel]').forEach((el) => {
        el.addEventListener('click', async () => {
            const it = items.find((x) => x.id === el.dataset.rdel);
            const ok = await confirmDialog(
                `체크항목 「${it?.title ?? ''}」을(를) 삭제할까요? 체크 기록은 남습니다.`);
            if (!ok) return;
            try {
                await db.deleteChecklistItem(el.dataset.rdel, user);
                toast('삭제했습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    table.querySelectorAll('[data-rprop]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = items.find((x) => x.id === el.dataset.rprop);
            if (!item) return;
            openForm({ item, kind: CHECK_KIND.CHECK }, {
                state: ctx.state, user, users, divisions: [], rows: items,
                findItem: (id) => items.find((x) => x.id === id) ?? null,
                reload,
            });
        });
    });
    bindDrag(table, user, reload);
}

/**
 * 저장 뒤 포커스를 되살린다 🔑 - 빈 행을 저장하면 표를 다시 그려 엘리먼트가 바뀌므로
 * **행 id + 칸**으로 다시 찾아 준다 (못 찾으면 새 빈 행의 첫 칸).
 */
function focusRow(body, id, field) {
    const tr = id ? body.querySelector(`.cl-reg tr[data-row="${CSS.escape(id)}"]`) : null;
    const el = tr?.querySelector(`[data-rf="${field}"]`)
        ?? body.querySelector('.cl-reg tr.is-draft [data-rf="category"]');
    el?.focus();
}

/** 줄 순서 - 손잡이(≡)를 잡아야 끌린다 (입력칸 글자 선택과 부딪히지 않게) */
function bindDrag(table, user, reload) {
    let drag = null;
    const rows = () => [...table.querySelectorAll('tr[data-row]:not(.is-draft)')];
    const clearMarks = () => rows()
        .forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after'));
    table.querySelectorAll('.pm-grip').forEach((grip) => {
        const tr = grip.closest('tr');
        grip.addEventListener('mousedown', () => tr.setAttribute('draggable', 'true'));
        grip.addEventListener('touchstart', () => tr.setAttribute('draggable', 'true'),
            { passive: true });
    });
    rows().forEach((tr) => {
        tr.addEventListener('dragstart', (e) => {
            if (tr.getAttribute('draggable') !== 'true') return;
            drag = tr.dataset.row;
            tr.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', drag);
        });
        tr.addEventListener('dragend', () => {
            tr.classList.remove('is-dragging');
            tr.removeAttribute('draggable');
            clearMarks();
            drag = null;
        });
        const above = (e) => {
            const r = tr.getBoundingClientRect();
            return e.clientY < r.top + r.height / 2;
        };
        tr.addEventListener('dragover', (e) => {
            if (!drag || drag === tr.dataset.row) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearMarks();
            tr.classList.add(above(e) ? 'is-drop-before' : 'is-drop-after');
        });
        tr.addEventListener('drop', async (e) => {
            if (!drag || drag === tr.dataset.row) return;
            e.preventDefault();
            const isBefore = above(e);
            const ids = rows().map((x) => x.dataset.row).filter((x) => x !== drag);
            const at = ids.indexOf(tr.dataset.row);
            ids.splice(isBefore ? at : at + 1, 0, drag);
            clearMarks();
            try {
                await db.reorderChecklistItems(null, ids, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}
