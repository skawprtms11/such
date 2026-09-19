/**
 * 일일체크리스트 (모바일 앱).
 *
 *   #/checklist   날짜 이동 · 등록 기준 3구획(일별 · 이번 주 · 이번 달) 카드 목록
 *
 * 목적은 **오늘 내가 빠뜨리면 안 되는 것**을 훑고 체크하는 것이다. 웹 탭1 과 같은
 * `db.checklistBoard()` 를 쓰므로 판정이 갈라지지 않는다 - 기간·담당자 상속·지난 기간
 * 미체크(`late`) 계산은 화면이 하지 않는다.
 * 🔑 현장작업자는 담당자 필터가 없다 - 자기 담당(정·부) + 공통 항목만 자동으로 나온다.
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { BOARD_CYCLES, CHECK_CYCLE } from '../../config.js';
import { esc, num, today, addDays, fmtDateTime, toast } from '../../util.js';
import { emptyState, tag, bigCounter, pollGuard } from '../ui.js';

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const state = { date: today() };

/** 구획 3개 - 순서가 곧 화면 순서다 (웹 탭1 과 같다) */
const SECTIONS = [
    { key: 'daily', cycle: CHECK_CYCLE.DAILY, name: '일별' },
    { key: 'weekly', cycle: CHECK_CYCLE.WEEKLY, name: '이번 주' },
    { key: 'monthly', cycle: CHECK_CYCLE.MONTHLY, name: '이번 달' },
];

/** `9/14` 꼴 짧은 날짜 */
function shortDate(dateStr) {
    const [, m, d] = String(dateStr).split('-');
    return `${Number(m)}/${Number(d)}`;
}

/** 구획 머리의 기간 - `9/14~9/20` `9월` */
function spanOf(cycle, date) {
    const start = db.periodStart(cycle, date);
    if (cycle === CHECK_CYCLE.WEEKLY) return `${shortDate(start)}~${shortDate(addDays(start, 6))}`;
    if (cycle === CHECK_CYCLE.MONTHLY) return `${Number(start.slice(5, 7))}월`;
    return shortDate(start);
}

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
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const counterEl = root.querySelector('#counter');
    const dateEl = root.querySelector('#f-date');
    let rows = [];

    async function reload() {
        const board = await db.checklistBoard(state.date, { user });
        rows = SECTIONS.flatMap((s) => board[s.key]);
        const done = rows.filter((r) => r.check?.checked_at).length;

        dateEl.value = state.date;
        counterEl.innerHTML = bigCounter(done, rows.length,
            rows.length ? `남은 항목 ${num(rows.length - done)}개` : '');
        listEl.innerHTML = rows.length
            ? SECTIONS.map((s) => sectionHtml(s, board[s.key], state.date, user)).join('')
            : emptyState('등록된 체크리스트가 없습니다 — 체크리스트 등록 탭에서 추가하세요.');
    }

    /** 체크 처리 - 실패하면 이유를 그대로 알린다 */
    async function toggle(row, on) {
        const memo = listEl.querySelector(`[data-memo="${CSS.escape(row.item.id)}"]`)?.value
            ?? row.check?.memo ?? '';
        try {
            await db.setCheck(row.item.id, state.date, on, memo, user);
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // 특이사항 - 체크 전에도 남길 수 있다. 저장 뒤 다시 그리지 않는다 (입력칸이 사라진다)
    listEl.addEventListener('change', async (e) => {
        const memoEl = e.target.closest('[data-memo]');
        if (!memoEl) return;
        try {
            await db.setCheckMemo(memoEl.dataset.memo, state.date, memoEl.value, user);
            memoEl.classList.remove('is-dirty');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    listEl.addEventListener('input', (e) => {
        if (e.target.closest('[data-memo]')) e.target.classList.add('is-dirty');
    });
    listEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-memo]')) return;      // 입력칸을 눌러 체크되면 곤란하다
        const card = e.target.closest('[data-item]');
        if (!card) return;
        const row = rows.find((r) => r.item.id === card.dataset.item);
        if (!row || !db.canCheckItem(user, row)) return;
        toggle(row, !row.check?.checked_at);
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
    return () => unwatch();
}

/** 체크한 시각·사람 한 줄 */
function doneNote(r, checked) {
    if (!checked) return '';
    return ` · ${esc(fmtDateTime(r.check.checked_at))} ${esc(r.check.checked_by_name)}`;
}

/** 구획 하나 - 기준 · 기간 · 진행 머리와 카드들 */
function sectionHtml(sec, list, date, user) {
    const done = list.filter((r) => r.check?.checked_at).length;
    return `
<h3 class="m-cb-sec">${esc(sec.name)}
  <span class="m-chk__meta">${esc(spanOf(sec.cycle, date))}</span>
  ${tag(`${num(done)} / ${num(list.length)}`, list.length && done === list.length ? 'green' : 'gray')}
</h3>
${list.length
        ? list.map((r) => cardHtml(r, user)).join('')
        : '<p class="m-chk__meta" style="padding:6px 2px">이 기준으로 등록된 항목이 없습니다.</p>'}`;
}

/**
 * 체크 카드 하나 🔑 - **체크해도 카드는 사라지지 않는다.** 흐리게 + 「완료」 + 체크자·시각으로
 * 남는다. 카드 전체가 터치 영역이다 (48px 이상, 장갑 낀 손).
 */
function cardHtml(r, user) {
    const checked = !!r.check?.checked_at;
    const locked = !db.canCheckItem(user, r);
    const subs = r.assignee_eff_subs ?? [];
    let who = r.assignee_eff_name ? esc(r.assignee_eff_name) : '';
    if (subs.length) who += `${who ? ' · ' : ''}부 ${esc(subs.map((s) => s.name).join(', '))}`;
    return `
<div class="m-chk m-cb ${checked ? 'is-done' : ''} ${locked ? 'is-locked' : ''}"
     data-item="${esc(r.item.id)}">
  <span class="m-chk__box">${icon(checked ? 'check' : 'square', 'm-icon')}</span>
  <span class="m-chk__text">
    <span class="m-chk__title">${esc(r.title)}
      ${checked ? '<span class="m-cb__badge">완료</span>' : ''}
      ${r.late && !checked ? '<span class="m-chk__late">지난 기간 미체크</span>' : ''}</span>
    ${r.description ? `<span class="m-cb__desc">${esc(r.description)}</span>` : ''}
    <span class="m-chk__meta">${esc(r.category || '-')} · ${esc(BOARD_CYCLES[r.cycle] ?? '')}
      · ${who || '공통'}${doneNote(r, checked)}</span>
    <input type="text" class="m-input m-cb__memo" data-memo="${esc(r.item.id)}" maxlength="200"
           value="${esc(r.check?.memo ?? '')}" placeholder="특이사항"
           aria-label="특이사항" ${locked ? 'readonly' : ''}>
  </span>
</div>`;
}
