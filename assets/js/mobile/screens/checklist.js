/**
 * 업무체크리스트 (모바일 앱).
 *
 *   #/checklist   날짜 이동 · 구분별 카드 · 큰 체크 터치 영역
 *
 * 웹 화면(pages/checklist.js)의 **오늘 할 일 탭만** 옮긴 것이다.
 * 항목 관리(트리 편집)는 좁은 화면에 맞지 않아 웹에만 둔다 (docs/checklist.md).
 * 🔑 주기 판정과 체크 권한은 화면이 하지 않는다 - db.dueItems() · db.canCheckItem() 이
 * 준 결과만 그린다. 웹과 같은 함수라 판정이 갈라지지 않는다.
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_CATEGORIES, CHECK_CYCLE, CHECK_CYCLES, cycleLabel } from '../../config.js';
import { esc, num, today, addDays, fmtDateTime, toast } from '../../util.js';
import {
    emptyState, tag, card, bigCounter, sheet, pollGuard, closeAllSheets,
} from '../ui.js';

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const state = { date: today() };

/** 수시 묶음 이름 - 날짜와 무관해 구분 카드와 따로 모은다 */
const ADHOC_GROUP = CHECK_CYCLES[CHECK_CYCLE.ADHOC];

export async function render(root, { user }) {
    root.innerHTML = `
<div class="m-datenav">
  <button class="m-btn m-btn--sm" type="button" id="btn-prev"
          aria-label="이전 날짜">${icon('back', 'm-icon')}</button>
  <input type="date" id="f-date" class="m-input" aria-label="날짜">
  <button class="m-btn m-btn--sm" type="button" id="btn-next"
          aria-label="다음 날짜">${icon('next', 'm-icon')}</button>
  <button class="m-btn m-btn--sm" type="button" id="btn-today">오늘</button>
</div>
<div id="counter"></div>
<div id="missed"></div>
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const counterEl = root.querySelector('#counter');
    const missedEl = root.querySelector('#missed');
    const dateEl = root.querySelector('#f-date');
    let rows = [];

    async function reload() {
        // 앱은 본인 담당 항목만 본다 (담당자 필터는 웹에만 있다)
        const f = { assignee: user.id };
        rows = await db.dueItems(state.date, f);
        const sum = await db.checklistSummary(state.date, f);

        dateEl.value = state.date;
        counterEl.innerHTML = bigCounter(sum.done, sum.total,
            sum.total ? `남은 항목 ${num(sum.total - sum.done)}개` : '');
        missedEl.innerHTML = sum.missed
            ? `<button class="m-btn m-btn--block" type="button" id="btn-missed"
                 >어제 미체크 ${num(sum.missed)}건</button>`
            : '';
        missedEl.querySelector('#btn-missed')?.addEventListener('click', () => {
            state.date = sum.prevDate;
            reload();
        });

        const groups = CHECK_CATEGORIES
            .map((c) => ({
                name: c,
                rows: rows.filter((r) => r.category === c && r.cycle !== CHECK_CYCLE.ADHOC),
            }))
            .concat([{
                name: ADHOC_GROUP,
                rows: rows.filter((r) => r.cycle === CHECK_CYCLE.ADHOC),
            }])
            .filter((g) => g.rows.length);

        listEl.innerHTML = groups.length
            ? groups.map((g) => groupCard(g, user)).join('')
            : emptyState('이 날짜에 해야 할 항목이 없습니다.');
    }

    /** 체크 처리 - 실패하면 이유를 그대로 알린다 */
    async function toggle(id, on, memo) {
        try {
            await db.setCheck(id, state.date, on, memo, user);
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    listEl.addEventListener('click', (e) => {
        const memoBtn = e.target.closest('[data-memo]');
        if (memoBtn) {
            const row = rows.find((r) => r.id === memoBtn.dataset.memo);
            if (row) openMemo(row, (memo) => toggle(row.id, true, memo));
            return;
        }
        const row = e.target.closest('[data-item]');
        if (!row) return;
        const item = rows.find((r) => r.id === row.dataset.item);
        if (!item || !db.canCheckItem(user, item)) return;
        toggle(item.id, !item.check, item.check?.memo ?? '');
    });

    root.querySelector('#btn-prev').addEventListener('click', () => {
        state.date = addDays(state.date, -1);
        reload();
    });
    root.querySelector('#btn-next').addEventListener('click', () => {
        state.date = addDays(state.date, 1);
        reload();
    });
    root.querySelector('#btn-today').addEventListener('click', () => {
        state.date = today();
        reload();
    });
    dateEl.addEventListener('change', () => {
        state.date = dateEl.value || today();
        reload();
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return () => {
        closeAllSheets();
        unwatch();
    };
}

/** 구분 카드 한 장 - 안에 체크 줄이 들어간다 */
function groupCard(g, user) {
    const done = g.rows.filter((r) => r.check).length;
    return card(esc(g.name), g.rows.map((r) => itemRow(r, user)).join(''), {
        badges: tag(`${num(done)} / ${num(g.rows.length)}`, done === g.rows.length ? 'green' : 'gray'),
    });
}

/** 체크 줄 - 터치 영역을 48px 이상으로 잡는다 (현장에서 장갑을 낀 채 누른다) */
function itemRow(r, user) {
    const locked = !db.canCheckItem(user, r);
    const done = !!r.check;
    return `
<div class="m-chk ${done ? 'is-done' : ''} ${locked ? 'is-locked' : ''}"
     data-item="${esc(r.id)}">
  <span class="m-chk__box">${icon(done ? 'check' : 'square', 'm-icon')}</span>
  <span class="m-chk__text">
    ${r.path ? `<span class="m-chk__path">${esc(r.path)}</span>` : ''}
    <span class="m-chk__title">${esc(r.title)}</span>
    <span class="m-chk__meta">${esc(cycleLabel(r))}${doneNote(r)}</span>
  </span>
  ${done ? `<button class="m-btn m-btn--sm ${r.check.memo ? 'is-on' : ''}" type="button"
      data-memo="${esc(r.id)}" aria-label="메모">${icon('memo', 'm-icon')}</button>` : ''}
</div>`;
}

/** 체크한 시각·사람 한 줄 */
function doneNote(r) {
    if (!r.check) return '';
    const at = esc(fmtDateTime(r.check.checked_at).slice(11));
    return ` · ${at} ${esc(r.check.checked_by_name)}`;
}

/** 메모 시트 - 체크한 항목에만 남긴다 */
function openMemo(row, onSave) {
    const s = sheet(row.title, `
<textarea class="m-textarea" id="memo" rows="3"
          placeholder="메모를 입력하세요">${esc(row.check?.memo ?? '')}</textarea>`, {
        footer: '<button class="m-btn m-btn--primary m-btn--block" type="button"'
            + ' id="btn-save">저장</button>',
    });
    s.foot.querySelector('#btn-save').addEventListener('click', async () => {
        const memo = s.body.querySelector('#memo').value;
        s.close();
        await onSave(memo);
    });
}
