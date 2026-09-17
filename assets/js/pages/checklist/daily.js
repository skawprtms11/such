/**
 * 업무체크리스트 탭 - **오늘 내가 빠뜨리면 안 되는 것**을 훑고 체크하는 목록.
 *
 *   일일 (기본)  그 날짜에 해야 하는 항목만 (주기·상황 발생 판정을 거친 것)
 *   전체        확인내용 전부. 그 날짜의 대상이 아닌 줄은 **회색 조회 전용**이다 🔑
 *
 * 주기·담당자 상속·상황 발생·어제 미체크 판정은 화면이 하지 않는다. db.checklistTable() ·
 * db.canCheckItem() 이 준 결과만 그린다 (docs/checklist.md).
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_KIND, cycleLabel } from '../../config.js';
import {
    esc, num, rate, toast, today, addDays, fmtDateTime, confirmDialog, promptDialog,
} from '../../util.js';
import { iconBtn, segHtml, stepCaption } from './common.js';

/** 담당자 필터를 db 조회 조건으로 바꾼다 ('나' 는 로그인 사용자) */
function assigneeFilter(state, user) {
    if (state.assignee === 'all') return {};
    return { assignee: state.assignee === 'me' ? user.id : state.assignee };
}

/** 표 뷰모델의 줄만 평평하게 (체크·메모 처리에서 id 로 찾는다) */
function flatRows(table) {
    return table.groups.flatMap((g) => g.sections.flatMap((sec) => sec.rows));
}

export async function drawToday(ctx) {
    const { state, body, headSum, user, users, canManage, reload } = ctx;
    const f = { ...assigneeFilter(state, user), scope: state.scope };
    const table = await db.checklistTable(state.date, f);
    const sum = await db.checklistSummary(state.date, assigneeFilter(state, user));
    const pct = rate(sum.done, sum.total);
    const rows = flatRows(table);

    headSum.textContent = `${num(sum.done)} / ${num(sum.total)}`;

    body.className = 'card__body';
    body.innerHTML = `
<div class="toolbar">
  <div class="cl-datenav">
    ${iconBtn('back', '이전 날짜', 'id="btn-prev"')}
    <input type="date" id="f-date" value="${esc(state.date)}" aria-label="날짜">
    ${iconBtn('next', '다음 날짜', 'id="btn-next"')}
    <button class="btn btn--sm" id="btn-today" type="button">오늘</button>
  </div>
  ${segHtml('seg-scope', [['daily', '일일'], ['all', '전체']], state.scope)}
  <label class="field" style="flex:0 0 170px">
    <span class="field__label">담당자</span>
    <select id="f-assignee" ${canManage ? '' : 'disabled'}>
      <option value="me" ${state.assignee === 'me' ? 'selected' : ''}>나</option>
      ${canManage ? `
      <option value="all" ${state.assignee === 'all' ? 'selected' : ''}>전체</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${state.assignee === u.id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}` : ''}
    </select>
  </label>
  ${segHtml('seg-done', [['open', '미완료'], ['all', '전체']], state.showDone ? 'all' : 'open')}
  <div class="toolbar__spacer"></div>
  <div class="cl-progress">
    <span class="cl-progress__num">남은 ${num(sum.total - sum.done)} · ${num(sum.done)} / ${num(sum.total)}</span>
    <div class="bar"><div class="bar__fill ${pct === 100 ? 'is-done' : ''}"
      style="width:${pct}%"></div></div>
  </div>
  ${sum.raised ? `<span class="tag tag--amber">상황 발생 ${num(sum.raised)}건</span>` : ''}
  ${sum.missed ? `
  <button class="btn btn--sm cl-missed" id="btn-missed" type="button"
    >어제 미체크 ${num(sum.missed)}건 →</button>` : ''}
</div>
${state.scope === 'all' ? `
<p class="cl-scope">${icon('checklist', 'icon icon--sm')}
  등록된 확인내용 전부입니다. ${esc(state.date)} 의 대상이 아닌 줄은 조회만 됩니다.</p>` : ''}
${table.divisions.length ? `<div class="dq">${table.divisions.map((d) => `
<div class="dq-div"><span class="dq-div__name">${esc(d.name)}</span>
  <span class="dq-div__cnt">${num(d.done)} / ${num(d.total)}</span></div>
${d.groups.map((g) => groupHtml(g, user, state)).join('')}`).join('')}</div>`
        : `<p class="empty">${state.scope === 'all'
            ? '등록된 확인내용이 없습니다.' : '이 날짜에 해야 할 항목이 없습니다.'}</p>`}`;

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
    body.querySelector('#f-assignee').addEventListener('change', (e) => {
        state.assignee = e.target.value;
        reload();
    });
    body.querySelectorAll('#seg-scope [data-seg]').forEach((el) => {
        el.addEventListener('click', () => {
            state.scope = el.dataset.seg;
            reload();
        });
    });
    body.querySelectorAll('#seg-done [data-seg]').forEach((el) => {
        el.addEventListener('click', () => {
            state.showDone = el.dataset.seg === 'all';
            reload();
        });
    });
    body.querySelector('#btn-missed')?.addEventListener('click', () => {
        state.date = sum.prevDate;
        reload();
    });
    body.querySelectorAll('[data-fold]').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.dataset.fold;
            if (state.openDone.has(id)) state.openDone.delete(id);
            else state.openDone.add(id);
            reload();
        });
    });

    /** 체크/해제 */
    body.querySelectorAll('[data-check]').forEach((el) => {
        el.addEventListener('change', async () => {
            const row = rows.find((r) => r.id === el.dataset.check);
            try {
                await db.setCheck(row.id, state.date, el.checked, row.check?.memo ?? '', user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-title]').forEach((el) => {
        el.addEventListener('click', () => {
            body.querySelector(`[data-check="${CSS.escape(el.dataset.title)}"]:not([disabled])`)
                ?.click();
        });
    });
    body.querySelectorAll('[data-memo]').forEach((el) => {
        el.addEventListener('click', async () => {
            const row = rows.find((r) => r.id === el.dataset.memo);
            if (!row.check) {
                toast('체크한 뒤에 메모를 남길 수 있습니다.', 'info');
                return;
            }
            const memo = await promptDialog('메모 (비우면 지워집니다)', row.check.memo ?? '');
            if (memo === null) return;
            try {
                await db.setCheck(row.id, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });

    /** 상황 발생 - 내용을 적고 발생 처리하면 대응 절차의 체크항목이 아래 줄로 끼어든다 */
    body.querySelectorAll('[data-raise]').forEach((el) => {
        el.addEventListener('click', async () => {
            const memo = await promptDialog(`「${el.dataset.name}」 발생 내용 (선택)`, '');
            if (memo === null) return;
            try {
                await db.setCheck(el.dataset.raise, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-sit-memo]').forEach((el) => {
        el.addEventListener('click', async () => {
            const memo = await promptDialog('발생 내용 (비우면 지워집니다)', el.dataset.value ?? '');
            if (memo === null) return;
            try {
                await db.setCheck(el.dataset.sitMemo, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-dismiss]').forEach((el) => {
        el.addEventListener('click', async () => {
            const ok = await confirmDialog(
                `「${el.dataset.name}」 발생을 해제할까요?\n이 상황 아래 오늘 체크한 기록도 함께 지워집니다.`,
            );
            if (!ok) return;
            try {
                await db.setCheck(el.dataset.dismiss, state.date, false, '', user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/**
 * 업무항목 한 묶음 - 왼쪽 이름 칸, 오른쪽에 미완료 줄(업무 순서)과 상황 칩, 그 뒤 완료 줄.
 * 완료 줄은 세그먼트가 「전체」이거나 「완료 N건 보기」 를 눌렀을 때만 펼친다.
 */
function groupHtml(g, user, state) {
    const open = state.showDone || state.openDone.has(g.item.id);
    const done = [];
    const parts = [];
    g.sections.forEach((sec) => {
        sec.rows.forEach((r) => {
            if (r.check) done.push({ r, sec });
            else parts.push(rowHtml(r, sec, user));
        });
        if (sec.situations.length) parts.push(sitChips(sec.situations, user));
    });
    if (done.length) {
        if (!state.showDone) {
            parts.push(`
<button class="dq-fold" type="button" data-fold="${esc(g.item.id)}">
  ${icon(open ? 'down' : 'next', 'icon icon--sm')}완료 ${num(done.length)}건 ${open ? '접기' : '보기'}</button>`);
        }
        if (open) parts.push(done.map(({ r, sec }) => rowHtml(r, sec, user)).join(''));
    }
    if (!parts.length) parts.push('<p class="dq-empty">할 항목이 없습니다.</p>');
    const allDone = g.total > 0 && g.done === g.total;
    return `
<div class="dq-grp">
  <div class="dq-grp__name">${esc(g.name)}
    <small class="${allDone ? 'is-done' : ''}">${num(g.done)} / ${num(g.total)}</small></div>
  <div class="dq-grp__rows">${parts.join('')}</div>
</div>`;
}

/** 프로세스 캡션 - `① 하차 파렛트수 확인 › ⚠ 입고수량오류 › 냉장 갈래` */
function pathCaption(sec) {
    if (!sec.path.length) return '단독 업무';
    return sec.path.map((n) => (n.sit
        ? `<span class="is-sit">${icon('issues', 'icon icon--sm')}${esc(n.title)}</span>`
        : stepCaption(n))).join(' › ');
}

/** 체크 줄 하나. 그 날짜의 대상이 아니면(due=false) 조회 전용이다 */
function rowHtml(r, sec, user) {
    const off = r.due === false;
    const locked = off || !db.canCheckItem(user, r);
    const done = !!r.check;
    const isStep = r.kind === CHECK_KIND.PROCESS;
    const doneAt = done
        ? `${esc(fmtDateTime(r.check.checked_at).slice(11))} ${esc(r.check.checked_by_name)}`
        : '';
    return `
<div class="dq-row ${done ? 'is-done' : ''} ${locked ? 'is-locked' : ''} ${sec.sit ? 'is-sit' : ''} ${off ? 'is-off' : ''}">
  <input type="checkbox" data-check="${esc(r.id)}" ${done ? 'checked' : ''}
         ${locked ? 'disabled' : ''} aria-label="${esc(r.title)}"
         ${off ? 'title="이 날짜의 대상이 아닙니다"' : ''}>
  <span class="dq-row__main" data-title="${esc(r.id)}">
    <span class="dq-row__title">
      ${isStep ? '<span class="dq-row__step">단계 완료</span>' : ''}
      <span>${esc(r.title)}</span>
      ${r.late && !done ? '<span class="dq-late">어제 미체크</span>' : ''}
      ${off ? '<span class="dq-off">대상 아님</span>' : ''}
    </span>
    ${r.description ? `<span class="dq-row__desc">${esc(r.description)}</span>` : ''}
    <span class="dq-row__proc">${pathCaption(sec)}${isStep ? '' : ` · ${esc(cycleLabel(r))}`}</span>
  </span>
  <span class="dq-row__who">${whoCell(r)}</span>
  <span class="dq-row__at">${doneAt}</span>
  ${iconBtn('memo', r.check?.memo ? `메모: ${r.check.memo}` : '메모',
        `data-memo="${esc(r.id)}"`, `btn btn--icon btn--sm ${r.check?.memo ? 'is-on' : ''}`)}
</div>`;
}

/** 담당 칸 - 정담당자 이름, 부담당자가 있으면 아래 작은 글씨. 아무도 없으면 「공통」 */
function whoCell(r) {
    const subs = r.assignee_eff_subs ?? [];
    if (!r.assignee_eff_name && !subs.length) return '공통';
    return `${esc(r.assignee_eff_name)}${subs.length
        ? `<small class="dq-row__sub">부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}`;
}

/** 프로세스에 달린 상황 칩 줄 - 발생 전은 점선 「발생」, 발생하면 주황 실선 + 내용·해제 */
function sitChips(situations, user) {
    return `
<div class="dq-sits">
  <span class="dq-sits__label">${icon('issues', 'icon icon--sm')}상황</span>
  ${situations.map((s) => {
        const mine = db.canCheckItem(user, s.item);
        const id = esc(s.item.id);
        const name = esc(s.item.title);
        if (!s.active) {
            return `
  <button class="cl-chip" type="button" data-raise="${id}" data-name="${name}"
          ${mine ? '' : 'disabled'} title="${esc(s.item.description || '눌러서 발생 처리')}">
    ${name} <span class="cl-chip__act">발생</span></button>`;
        }
        const a = s.active;
        const note = `${esc(fmtDateTime(a.checked_at).slice(11))} ${esc(a.checked_by_name)}`
            + (a.memo ? ` · ${esc(a.memo)}` : '');
        return `
  <span class="cl-chip is-active">
    ${name} 발생
    <span class="cl-chip__note">${note}</span>
    ${mine ? iconBtn('memo', '발생 내용', `data-sit-memo="${id}" data-value="${esc(a.memo ?? '')}"`,
        `btn btn--icon btn--sm ${a.memo ? 'is-on' : ''}`) : ''}
    ${mine ? iconBtn('close', '발생 해제', `data-dismiss="${id}" data-name="${name}"`) : ''}
  </span>`;
    }).join('')}
</div>`;
}
