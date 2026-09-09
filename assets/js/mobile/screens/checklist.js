/**
 * 업무체크리스트 - 일일체크리스트 (모바일 앱).
 *
 *   #/checklist   날짜 이동 · 업무항목 카드 안에 [프로세스 | 체크리스트] 2단 표 · 큰 체크 터치 영역
 *
 * 웹 화면(pages/checklist.js)의 **일일체크리스트 탭만** 옮긴 것이다. 웹은 업무항목·프로세스·
 * 체크리스트 3컬럼 표인데, 폰에서는 업무항목을 카드 제목으로 올리고 프로세스 | 체크리스트
 * 2단만 남긴다 (docs/checklist.md). 업무프로세스 편집은 웹에만 둔다.
 * 🔑 주기·담당자 상속·상황 발생 판정은 화면이 하지 않는다 - db.dailyTable() ·
 * db.canCheckItem() 이 준 결과만 그린다. 웹과 같은 함수라 판정이 갈라지지 않는다.
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_KIND, cycleLabel } from '../../config.js';
import { esc, num, today, addDays, fmtDateTime, toast } from '../../util.js';
import {
    emptyState, tag, card, bigCounter, sheet, pollGuard, closeAllSheets,
} from '../ui.js';

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const state = { date: today() };

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
    let sits = new Map();      // 상황 id → SituationVM (발생/해제 시트에서 쓴다)

    async function reload() {
        // 앱은 본인 담당(상속 포함) + 공통 항목만 본다 (담당자 필터는 웹에만 있다)
        const f = { assignee: user.id };
        const table = await db.dailyTable(state.date, f);
        rows = await db.dueItems(state.date, f);
        const sum = await db.checklistSummary(state.date, f);
        sits = collectSituations(table);

        dateEl.value = state.date;
        const note = [
            sum.total ? `남은 항목 ${num(sum.total - sum.done)}개` : '',
            sum.raised ? `상황 발생 ${num(sum.raised)}건` : '',
        ].filter(Boolean).join(' · ');
        counterEl.innerHTML = bigCounter(sum.done, sum.total, note);
        missedEl.innerHTML = sum.missed
            ? `<button class="m-btn m-btn--block" type="button" id="btn-missed"
                 >어제 미체크 ${num(sum.missed)}건</button>`
            : '';
        missedEl.querySelector('#btn-missed')?.addEventListener('click', () => {
            state.date = sum.prevDate;
            reload();
        });

        listEl.innerHTML = table.groups.length
            ? table.groups.map((g) => groupCard(g, user)).join('')
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
        const raise = e.target.closest('[data-raise]');
        if (raise) {
            const s = sits.get(raise.dataset.raise);
            if (s) openRaise(s, (memo) => toggle(s.item.id, true, memo));
            return;
        }
        const sitBtn = e.target.closest('[data-sit]');
        if (sitBtn) {
            const s = sits.get(sitBtn.dataset.sit);
            if (s && db.canCheckItem(user, s.item)) {
                openActive(s, (memo) => toggle(s.item.id, true, memo),
                    () => toggle(s.item.id, false, ''));
            }
            return;
        }
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

/** 표 뷰모델 안의 상황을 id 로 찾을 수 있게 모은다 */
function collectSituations(table) {
    const out = new Map();
    table.groups.forEach((g) => g.sections.forEach((sec) => {
        sec.situations.forEach((s) => out.set(s.item.id, s));
    }));
    return out;
}

/**
 * 업무항목 카드 한 장 - 안은 [프로세스 | 체크리스트] 2단 표.
 * 프로세스 칸이 왼쪽, 그 프로세스의 체크항목들이 오른쪽에 쌓인다 (웹 표의 rowspan 과 같은 뜻).
 */
function groupCard(g, user) {
    const body = `<div class="m-dl">${g.sections.map((sec) => sectionHtml(sec, user)).join('')}</div>`;
    return card(esc(g.name), body, {
        badges: tag(`${num(g.done)} / ${num(g.total)}`,
            g.total && g.done === g.total ? 'green' : 'gray'),
    });
}

/** 구간(프로세스) 한 단 - 왼쪽 프로세스 경로, 오른쪽 체크 줄들 + 상황 칩 */
function sectionHtml(sec, user) {
    const done = sec.rows.filter((r) => r.check).length;
    const inSit = !!sec.sit;
    return `
<div class="m-dl__sec ${inSit ? 'is-sit' : ''}">
  <div class="m-dl__proc">
    ${sec.path.length ? pathHtml(sec.path, sec.sit) : '<span class="m-dl__proc-name">단독 업무</span>'}
    ${sec.rows.length ? `<span class="m-dl__proc-cnt">${num(done)} / ${num(sec.rows.length)}</span>` : ''}
  </div>
  <div class="m-dl__items">
    ${sec.rows.map((r) => itemRow(r, user)).join('')}
    ${sec.situations.length ? sitChips(sec.situations, user) : ''}
  </div>
</div>`;
}

/** 프로세스 경로 - 상위는 작게, 마지막 이름은 굵게. 상황 아래 구간이면 상황명을 주황으로 */
function pathHtml(path, sit) {
    return path.map((name, i) => {
        const isSit = sit && name === sit.title;
        const last = i === path.length - 1;
        const cls = isSit ? 'm-dl__proc-sit' : (last ? 'm-dl__proc-name' : 'm-dl__proc-parent');
        return `<span class="${cls}">${isSit ? icon('issues', 'm-icon') : ''}${esc(name)}</span>`;
    }).join('');
}

/** 체크 줄 - 줄 전체가 터치 영역 (48px 이상, 장갑 낀 손) */
function itemRow(r, user) {
    const locked = !db.canCheckItem(user, r);
    const done = !!r.check;
    const isStep = r.kind === CHECK_KIND.PROCESS;
    return `
<div class="m-chk ${done ? 'is-done' : ''} ${locked ? 'is-locked' : ''}"
     data-item="${esc(r.id)}">
  <span class="m-chk__box">${icon(done ? 'check' : 'square', 'm-icon')}</span>
  <span class="m-chk__text">
    ${isStep ? '<span class="m-chk__path">단계 완료</span>' : ''}
    <span class="m-chk__title">${esc(r.title)}</span>
    <span class="m-chk__meta">${isStep ? '' : esc(cycleLabel(r))}${doneNote(r)}</span>
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

/** 상황 칩 줄 - 발생 전은 점선 「발생」, 발생하면 주황 실선(누르면 내용·해제 시트) */
function sitChips(situations, user) {
    return `
<div class="m-sits">
  ${situations.map((s) => {
        const mine = db.canCheckItem(user, s.item);
        if (!s.active) {
            return `
  <button class="m-chip" type="button" data-raise="${esc(s.item.id)}" ${mine ? '' : 'disabled'}>
    ${icon('issues', 'm-icon')}<span class="m-chip__label">${esc(s.item.title)}</span>
    <span class="m-chip__act">발생</span></button>`;
        }
        return `
  <button class="m-chip is-active" type="button" data-sit="${esc(s.item.id)}">
    ${icon('issues', 'm-icon')}<span class="m-chip__label">${esc(s.item.title)} 발생</span>
    ${s.active.memo ? `<span class="m-chip__note">${esc(s.active.memo)}</span>` : ''}
    ${icon('more', 'm-icon')}</button>`;
    }).join('')}
</div>`;
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

/** 상황 발생 시트 - 어떤 때인지 보여 주고 내용을 적어 발생 처리한다 */
function openRaise(sit, onRaise) {
    const steps = sit.subs.map((p) => p.item.title);
    const s = sheet(`${sit.item.title} 발생`, `
${sit.item.description ? `<p class="m-sit__desc">${esc(sit.item.description)}</p>` : ''}
${steps.length ? `<p class="m-sit__desc">대응 절차: ${steps.map(esc).join(' → ')}</p>` : ''}
<textarea class="m-textarea" id="memo" rows="3"
          placeholder="발생 내용 (선택)"></textarea>`, {
        footer: '<button class="m-btn m-btn--primary m-btn--block" type="button"'
            + ' id="btn-raise">발생 처리</button>',
    });
    s.foot.querySelector('#btn-raise').addEventListener('click', async () => {
        const memo = s.body.querySelector('#memo').value;
        s.close();
        await onRaise(memo);
    });
}

/** 발생한 상황 시트 - 내용 수정 · 발생 해제 */
function openActive(sit, onSave, onDismiss) {
    const s = sheet(`${sit.item.title} 발생`, `
${sit.item.description ? `<p class="m-sit__desc">${esc(sit.item.description)}</p>` : ''}
<textarea class="m-textarea" id="memo" rows="3"
          placeholder="발생 내용">${esc(sit.active?.memo ?? '')}</textarea>
<p class="m-sit__desc">발생을 해제하면 이 상황 아래 오늘 체크한 기록도 함께 지워집니다.</p>`, {
        footer: `
<button class="m-btn m-btn--danger" type="button" id="btn-dismiss">발생 해제</button>
<button class="m-btn m-btn--primary" type="button" id="btn-save">내용 저장</button>`,
    });
    s.foot.querySelector('#btn-save').addEventListener('click', async () => {
        const memo = s.body.querySelector('#memo').value;
        s.close();
        await onSave(memo);
    });
    s.foot.querySelector('#btn-dismiss').addEventListener('click', async () => {
        s.close();
        await onDismiss();
    });
}
