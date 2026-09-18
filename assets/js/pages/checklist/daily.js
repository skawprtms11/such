/**
 * 일일체크리스트 탭 🔑 - **등록 기준(일별·주차별·월별)으로 묶은 내 체크리스트**.
 *
 *   일별        그 날짜 하루
 *   이번 주     그 날짜가 속한 주(월~일) - 주 안에서 어느 날 눌러도 기록은 1건이다
 *   이번 달     그 날짜가 속한 달
 *
 * 화면은 `db.checklistBoard(date, {assignee, user})` 가 준 세 묶음을 그대로 그린다.
 * 기간 판정·담당자 상속·지난 기간 미체크(`late`) 계산은 화면이 하지 않는다 (docs/checklist.md).
 * 🔑 트리(업무프로세스)와 상황 발생은 이 탭이 다루지 않는다 - 흐름은 업무프로세스 탭의 몫이다.
 */
import * as db from '../../db.js';
import { BOARD_CYCLES, CHECK_CYCLE } from '../../config.js';
import { esc, num, rate, toast, today, addDays, fmtDateTime } from '../../util.js';
import { iconBtn } from './common.js';

/** 구획 3개 - 순서가 곧 화면 순서다 */
const SECTIONS = [
    { key: 'daily', cycle: CHECK_CYCLE.DAILY },
    { key: 'weekly', cycle: CHECK_CYCLE.WEEKLY },
    { key: 'monthly', cycle: CHECK_CYCLE.MONTHLY },
];

/** `9/14` 꼴 짧은 날짜 */
function shortDate(dateStr) {
    const [, m, d] = String(dateStr).split('-');
    return `${Number(m)}/${Number(d)}`;
}

/** 구획 머리 - `이번 주 (9/14~9/20)` `이번 달 (9월)` 처럼 기간을 밝힌다 */
function sectionHead(cycle, date) {
    const start = db.periodStart(cycle, date);
    if (cycle === CHECK_CYCLE.WEEKLY) {
        return { name: '이번 주', span: `${shortDate(start)}~${shortDate(addDays(start, 6))}` };
    }
    if (cycle === CHECK_CYCLE.MONTHLY) {
        return { name: '이번 달', span: `${Number(start.slice(5, 7))}월` };
    }
    return { name: '일별', span: shortDate(start) };
}

/** 담당자 필터를 db 조회 조건으로 바꾼다 (권한자만 쓴다 - 'all' 이면 조건 없음) */
function assigneeOf(state, user, canManage) {
    if (!canManage) return undefined;                    // 비권한자는 checklistBoard 가 거른다
    if (state.assignee === 'all') return undefined;
    return state.assignee === 'me' ? user.id : state.assignee;
}

export async function drawToday(ctx) {
    const { state, body, headSum, user, users, canManage, reload } = ctx;
    const board = await db.checklistBoard(state.date, {
        assignee: assigneeOf(state, user, canManage), user,
    });
    const rows = SECTIONS.flatMap((s) => board[s.key]);
    const done = rows.filter((r) => r.check?.checked_at).length;
    const pct = rate(done, rows.length);

    headSum.textContent = `${num(done)} / ${num(rows.length)}`;

    body.className = 'card__body';
    body.innerHTML = `
<div class="toolbar">
  <div class="cl-datenav">
    ${iconBtn('back', '이전 날짜', 'id="btn-prev"')}
    <input type="date" id="f-date" value="${esc(state.date)}" aria-label="날짜">
    ${iconBtn('next', '다음 날짜', 'id="btn-next"')}
    <button class="btn btn--sm" id="btn-today" type="button">오늘</button>
  </div>
  ${canManage ? `
  <label class="field" style="flex:0 0 170px">
    <span class="field__label">담당자</span>
    <select id="f-assignee">
      <option value="all" ${state.assignee === 'all' ? 'selected' : ''}>전체</option>
      <option value="me" ${state.assignee === 'me' ? 'selected' : ''}>나</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${state.assignee === u.id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}
    </select>
  </label>` : ''}
  <div class="toolbar__spacer"></div>
  <div class="cl-progress">
    <span class="cl-progress__num">남은 ${num(rows.length - done)} · ${num(done)} / ${num(rows.length)}</span>
    <div class="bar"><div class="bar__fill ${pct === 100 ? 'is-done' : ''}"
      style="width:${pct}%"></div></div>
  </div>
</div>
${rows.length
        ? SECTIONS.map((s) => sectionHtml(s, board[s.key], state.date, user)).join('')
        : '<p class="empty">등록된 체크리스트가 없습니다 — 체크리스트 등록 탭에서 추가하세요.</p>'}`;

    body.querySelector('#btn-prev').addEventListener('click', () => {
        state.date = addDays(state.date, -1);
        reload();
    });
    body.querySelector('#btn-next').addEventListener('click', () => {
        state.date = addDays(state.date, 1);
        reload();
    });
    body.querySelector('#btn-today').addEventListener('click', () => {
        state.date = today();
        reload();
    });
    body.querySelector('#f-date').addEventListener('change', (e) => {
        state.date = e.target.value || today();
        reload();
    });
    body.querySelector('#f-assignee')?.addEventListener('change', (e) => {
        state.assignee = e.target.value;
        reload();
    });

    /** 체크/해제 - 특이사항은 적어 둔 값을 함께 넘겨 지워지지 않게 한다 */
    body.querySelectorAll('[data-check]').forEach((el) => {
        el.addEventListener('change', async () => {
            const row = rows.find((r) => r.item.id === el.dataset.check);
            const memo = body.querySelector(`[data-memo="${CSS.escape(row.item.id)}"]`)?.value
                ?? row.check?.memo ?? '';
            try {
                await db.setCheck(row.item.id, state.date, el.checked, memo, user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });

    /* 특이사항 - 체크 전에도 남길 수 있다 (그날 있었던 일은 체크와 별개다).
       실시간 갱신이 입력하던 값을 지우지 않게 is-dirty 를 붙인다 (checklist.js 의 guarded) */
    body.querySelectorAll('[data-memo]').forEach((el) => {
        el.addEventListener('input', () => el.classList.add('is-dirty'));
        el.addEventListener('change', async () => {
            try {
                // 🔑 다시 그리지 않는다 - 그리면 Tab 으로 옮긴 포커스가 사라진다
                await db.setCheckMemo(el.dataset.memo, state.date, el.value, user);
                el.classList.remove('is-dirty');
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 구획 하나 - 머리(기준·기간·진행) + 표 */
function sectionHtml(sec, list, date, user) {
    const { name, span } = sectionHead(sec.cycle, date);
    const done = list.filter((r) => r.check?.checked_at).length;
    return `
<div class="cb-sec">
  <div class="cb-sec__head">
    <span class="cb-sec__name">${esc(name)}</span>
    <span class="cb-sec__span">${esc(span)}</span>
    <span class="cb-sec__cnt ${list.length && done === list.length ? 'is-done' : ''}"
      >${num(done)} / ${num(list.length)}</span>
  </div>
  ${list.length ? `
  <table class="cb">
    <thead><tr>
      <th>구분</th><th>항목</th><th>주기</th><th>담당자</th><th>내용</th>
      <th>체크</th><th>특이사항</th>
    </tr></thead>
    <tbody>${list.map((r) => rowHtml(r, user)).join('')}</tbody>
  </table>`
        : '<p class="cb-sec__empty">이 기준으로 등록된 항목이 없습니다.</p>'}
</div>`;
}

/**
 * 체크 줄 하나 🔑 - **체크해도 줄은 사라지지 않는다.** 흐리게 + 「완료」 배지 + 체크자·시각으로
 * 남는다 (누가 언제 했는지가 현장의 근거다).
 */
function rowHtml(r, user) {
    const checked = !!r.check?.checked_at;
    const locked = !db.canCheckItem(user, r);
    return `
<tr class="${checked ? 'is-done' : ''} ${locked ? 'is-locked' : ''}">
  <td class="cb__cat">${esc(r.category || '-')}</td>
  <td class="cb__title">${esc(r.title)}
    ${checked ? '<span class="cb__badge">완료</span>' : ''}
    ${r.late && !checked ? '<span class="cb__late">지난 기간 미체크</span>' : ''}
    ${checked ? `<small class="cb__at">${esc(fmtDateTime(r.check.checked_at))}
      ${esc(r.check.checked_by_name)}</small>` : ''}</td>
  <td class="cb__cycle">${esc(BOARD_CYCLES[r.cycle] ?? '')}</td>
  <td class="cb__who">${whoCell(r)}</td>
  <td class="cb__desc">${esc(r.description)}</td>
  <td class="cb__check">
    <input type="checkbox" data-check="${esc(r.item.id)}" ${checked ? 'checked' : ''}
           ${locked ? 'disabled' : ''} aria-label="${esc(r.title)} 체크"></td>
  <td><input type="text" class="cb__memo" data-memo="${esc(r.item.id)}" maxlength="200"
             value="${esc(r.check?.memo ?? '')}" placeholder="특이사항"
             aria-label="특이사항" ${locked ? 'readonly' : ''}></td>
</tr>`;
}

/** 담당 칸 - 정담당자 이름, 부담당자가 있으면 아래 작은 글씨. 아무도 없으면 「공통」 */
function whoCell(r) {
    const subs = r.assignee_eff_subs ?? [];
    if (!r.assignee_eff_name && !subs.length) return '공통';
    return `${esc(r.assignee_eff_name)}${subs.length
        ? `<small class="cb__sub">부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}`;
}
